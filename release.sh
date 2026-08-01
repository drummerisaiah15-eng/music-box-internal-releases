#!/usr/bin/env bash
# Music Box Internal — verified, fail-closed arm64 release
# Usage: ./release.sh           (bump patch)
#        ./release.sh minor     (bump minor)
#        ./release.sh major     (bump major)
#        ./release.sh 1.2.0     (set exact version)

set -Eeuo pipefail

ELECTRON_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="${ELECTRON_DIR}/package.json"
LOCKFILE="${ELECTRON_DIR}/package-lock.json"
GIT_BIN="/usr/bin/git"
ENV_BIN="/usr/bin/env"
RELEASE_BACKUP_DIR=""
RELEASE_STAGE_DIR=""
RELEASE_WORKTREE_PARENT=""
RELEASE_SOURCE_DIR=""
RELEASE_LOCK_DIR=""
RELEASE_VERSION_MUTATED=0
RELEASE_PUBLISHED=0
MUSIC_BOX_PUBLICATION_STATE_FILE=""
MUSIC_BOX_SOURCE_CONTENT_MANIFEST=""
RELEASE_GH_TOKEN=""
export -n RELEASE_GH_TOKEN

NODE_BIN="$(command -v node 2>/dev/null || true)"
NPM_BIN="$(command -v npm 2>/dev/null || true)"
if [[ "$NODE_BIN" != /* || ! -x "$NODE_BIN" || "$NPM_BIN" != /* || ! -x "$NPM_BIN" ]]; then
  echo "ERROR: Release requires executable absolute node and npm paths." >&2
  exit 1
fi
NODE_BIN_DIR="$(cd "$(dirname "$NODE_BIN")" && pwd -P)"
NPM_BIN_DIR="$(cd "$(dirname "$NPM_BIN")" && pwd -P)"
NODE_BIN="${NODE_BIN_DIR}/$(basename "$NODE_BIN")"
NPM_BIN="${NPM_BIN_DIR}/$(basename "$NPM_BIN")"
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:${NODE_BIN_DIR}:${NPM_BIN_DIR}"
cd "$ELECTRON_DIR"

publication_state() {
  if [[ -n "$MUSIC_BOX_PUBLICATION_STATE_FILE" && -f "$MUSIC_BOX_PUBLICATION_STATE_FILE" ]]; then
    tr -d '[:space:]' < "$MUSIC_BOX_PUBLICATION_STATE_FILE"
  else
    printf 'not-started'
  fi
}

verify_isolated_source() {
  local changed_files
  if ! "$GIT_BIN" -C "$RELEASE_SOURCE_DIR" diff --cached --quiet; then
    echo "ERROR: Isolated release worktree unexpectedly changed the Git index." >&2
    exit 1
  fi
  changed_files="$("$GIT_BIN" -C "$RELEASE_SOURCE_DIR" diff --name-only | sort)"
  if [[ "$changed_files" != $'package-lock.json\npackage.json' ]]; then
    echo "ERROR: Isolated release source differs beyond the controlled version files." >&2
    printf 'Changed files:\n%s\n' "$changed_files" >&2
    exit 1
  fi
  if [[ -n "$("$GIT_BIN" -C "$RELEASE_SOURCE_DIR" \
    ls-files --others --exclude-standard)" ]]; then
    echo "ERROR: Isolated release source contains unexpected untracked files." >&2
    exit 1
  fi
  if [[ "$("$GIT_BIN" -C "$RELEASE_SOURCE_DIR" rev-parse HEAD)" != "$SOURCE_COMMIT" ]] ||
    [[ "$("$GIT_BIN" -C "$RELEASE_SOURCE_DIR" rev-parse 'HEAD^{tree}')" != "$SOURCE_TREE" ]]; then
    echo "ERROR: Isolated release source does not match recorded provenance." >&2
    exit 1
  fi
  if ! cmp -s \
    "${RELEASE_BACKUP_DIR}/release-package.json" \
    "${RELEASE_SOURCE_DIR}/package.json" ||
    ! cmp -s \
      "${RELEASE_BACKUP_DIR}/release-package-lock.json" \
      "${RELEASE_SOURCE_DIR}/package-lock.json"; then
    echo "ERROR: Controlled release version files changed after preparation." >&2
    exit 1
  fi
}

cleanup_release() {
  local exit_status=$?
  local remote_state
  local keep_stage=0
  trap - EXIT INT TERM HUP
  remote_state="$(publication_state)"

  if (( exit_status != 0 && RELEASE_VERSION_MUTATED == 1 && RELEASE_PUBLISHED == 0 )); then
    case "$remote_state" in
      creating|draft|publishing|unknown|published)
        echo "Release failed after GitHub activity began (state: $remote_state)." >&2
        echo "Version files were retained to prevent accidental version reuse." >&2
        keep_stage=1
        ;;
      *)
        echo "Release failed before GitHub activity; restoring package.json and package-lock.json." >&2
        cp "${RELEASE_BACKUP_DIR}/package.json" "$PKG"
        cp "${RELEASE_BACKUP_DIR}/package-lock.json" "$LOCKFILE"
        ;;
    esac
  fi

  if (( keep_stage == 1 )); then
    echo "Isolated release evidence retained at: $RELEASE_STAGE_DIR" >&2
  elif [[ -n "$RELEASE_STAGE_DIR" && -d "$RELEASE_STAGE_DIR" ]]; then
    rm -rf "$RELEASE_STAGE_DIR"
  fi
  if [[ -n "$RELEASE_SOURCE_DIR" ]]; then
    "$GIT_BIN" -C "$ELECTRON_DIR" worktree remove --force "$RELEASE_SOURCE_DIR" \
      >/dev/null 2>&1 || true
    if [[ -d "$RELEASE_SOURCE_DIR" ]]; then
      rm -rf "$RELEASE_SOURCE_DIR"
    fi
  fi
  if [[ -n "$RELEASE_WORKTREE_PARENT" && -d "$RELEASE_WORKTREE_PARENT" ]]; then
    rmdir "$RELEASE_WORKTREE_PARENT" 2>/dev/null || true
  fi
  if [[ -n "$RELEASE_BACKUP_DIR" && -d "$RELEASE_BACKUP_DIR" ]]; then
    rm -rf "$RELEASE_BACKUP_DIR"
  fi
  if [[ -n "$RELEASE_LOCK_DIR" && -d "$RELEASE_LOCK_DIR" ]]; then
    rm -f "${RELEASE_LOCK_DIR}/pid"
    rmdir "$RELEASE_LOCK_DIR" 2>/dev/null || true
  fi

  exit "$exit_status"
}

for tool in \
  "$GIT_BIN" "$ENV_BIN" "$NODE_BIN" "$NPM_BIN" \
  /usr/bin/codesign /usr/sbin/spctl /usr/bin/xcrun /usr/bin/hdiutil \
  /usr/bin/plutil /usr/bin/lipo /usr/bin/unzip /usr/bin/ditto; do
  if [[ ! -x "$tool" ]]; then
    echo "ERROR: Required release tool is missing or not executable: $tool" >&2
    exit 1
  fi
done

GIT_DIR="$("$GIT_BIN" rev-parse --git-dir 2>/dev/null)" || {
  echo "ERROR: Releases must run from a Git worktree." >&2
  exit 1
}
if [[ "$GIT_DIR" != /* ]]; then
  GIT_DIR="${ELECTRON_DIR}/${GIT_DIR}"
fi
RELEASE_LOCK_DIR="${GIT_DIR}/music-box-internal-release.lock"
if ! mkdir "$RELEASE_LOCK_DIR" 2>/dev/null; then
  echo "ERROR: Another Music Box release is already running (${RELEASE_LOCK_DIR})." >&2
  exit 1
fi
printf '%s\n' "$$" > "${RELEASE_LOCK_DIR}/pid"
trap cleanup_release EXIT
trap 'exit 130' INT TERM HUP

if [[ -n "$("$GIT_BIN" status --porcelain=v1 --untracked-files=all)" ]]; then
  echo "ERROR: Release requires a completely clean Git worktree and index." >&2
  exit 1
fi

SOURCE_COMMIT="$("$GIT_BIN" rev-parse HEAD)"
SOURCE_TREE="$("$GIT_BIN" rev-parse 'HEAD^{tree}')"
if [[ ! "$SOURCE_COMMIT" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]]; then
  echo "ERROR: Could not establish a valid source commit." >&2
  exit 1
fi
if [[ ! "$SOURCE_TREE" =~ ^[0-9a-fA-F]{40}([0-9a-fA-F]{24})?$ ]]; then
  echo "ERROR: Could not establish a valid source tree." >&2
  exit 1
fi

CURRENT="$("$NODE_BIN" -p "require('./package.json').version")"
SEMVER_PATTERN='^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if [[ ! "$CURRENT" =~ $SEMVER_PATTERN ]]; then
  echo "ERROR: Current package version is not strict stable semver: $CURRENT" >&2
  exit 1
fi
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

BUMP="${1:-patch}"
case "$BUMP" in
  major) NEXT="$((MAJOR + 1)).0.0" ;;
  minor) NEXT="${MAJOR}.$((MINOR + 1)).0" ;;
  patch) NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  *)
    if [[ "$BUMP" =~ $SEMVER_PATTERN ]]; then
      NEXT="$BUMP"
    else
      echo "ERROR: Unknown version '$BUMP' (use patch, minor, major, or x.y.z)." >&2
      exit 1
    fi
    ;;
esac

# V159-010: the release may build a version that is ALREADY committed. That is
# the provenance-correct path: SOURCE_COMMIT then genuinely contains the version
# being shipped, so an external auditor can rebuild the exact artifact from
# public source. The previous behaviour forced an uncommitted in-place bump,
# which is why published releases advertised a commit whose package.json carried
# the wrong version.
VERSION_ALREADY_COMMITTED=0
if [[ "$NEXT" == "$CURRENT" ]]; then
  VERSION_ALREADY_COMMITTED=1
  echo "Version $NEXT is already committed at HEAD; building it directly (no in-place bump)."
elif ! "$NODE_BIN" -e "
  const parse = value => value.split('.').map(Number);
  const [next, current] = process.argv.slice(1).map(parse);
  const greater = next.some((part, index) =>
    part > current[index] && next.slice(0, index).every((v, i) => v === current[i]));
  process.exit(greater ? 0 : 1);
" "$NEXT" "$CURRENT"; then
  echo "ERROR: Next version $NEXT must be greater than or equal to local version $CURRENT." >&2
  exit 1
fi

if [[ -n "${APPLE_ID:-}" || -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" ]]; then
  echo "ERROR: Apple ID/password notarization is disabled because it exposes a password via process arguments." >&2
  echo "Use APPLE_KEYCHAIN_PROFILE (preferred) or the APPLE_API_KEY credential set." >&2
  exit 1
fi
if [[ -z "${APPLE_TEAM_ID:-}" || ! "${APPLE_TEAM_ID}" =~ ^[A-Z0-9]{10}$ ]]; then
  echo "ERROR: APPLE_TEAM_ID must be a 10-character Apple Developer Team ID." >&2
  exit 1
fi

HAS_KEYCHAIN_PROFILE=0
[[ -n "${APPLE_KEYCHAIN_PROFILE:-}" ]] && HAS_KEYCHAIN_PROFILE=1
HAS_API_CREDENTIAL=0
[[ -n "${APPLE_API_KEY:-}" || -n "${APPLE_API_KEY_ID:-}" || -n "${APPLE_API_ISSUER:-}" ]] && HAS_API_CREDENTIAL=1
if (( HAS_KEYCHAIN_PROFILE == 1 && HAS_API_CREDENTIAL == 1 )); then
  echo "ERROR: Configure exactly one notarization strategy, not both keychain and API credentials." >&2
  exit 1
fi
if (( HAS_KEYCHAIN_PROFILE == 0 && HAS_API_CREDENTIAL == 0 )); then
  echo "ERROR: Set APPLE_KEYCHAIN_PROFILE or APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER." >&2
  exit 1
fi
if (( HAS_API_CREDENTIAL == 1 )) &&
  [[ -z "${APPLE_API_KEY:-}" || -z "${APPLE_API_KEY_ID:-}" || -z "${APPLE_API_ISSUER:-}" ]]; then
  echo "ERROR: APPLE_API_KEY, APPLE_API_KEY_ID, and APPLE_API_ISSUER must all be set." >&2
  exit 1
fi
if (( HAS_API_CREDENTIAL == 1 )) && [[ ! -r "$APPLE_API_KEY" ]]; then
  echo "ERROR: APPLE_API_KEY is not a readable private-key file." >&2
  exit 1
fi
if [[ -z "${GH_TOKEN:-}" ]]; then
  echo "ERROR: GH_TOKEN is required." >&2
  exit 1
fi
RELEASE_GH_TOKEN="$GH_TOKEN"
export -n RELEASE_GH_TOKEN
unset GH_TOKEN

export MUSIC_BOX_SOURCE_COMMIT="$SOURCE_COMMIT"
export MUSIC_BOX_SOURCE_TREE="$SOURCE_TREE"
export MUSIC_BOX_RELEASE_VERSION="$NEXT"

RELEASE_BACKUP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/music-box-release-backup.XXXXXX")"
RELEASE_STAGE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/music-box-release-output.XXXXXX")"
RELEASE_WORKTREE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/music-box-release-source.XXXXXX")"
RELEASE_SOURCE_DIR="${RELEASE_WORKTREE_PARENT}/source"
MUSIC_BOX_PUBLICATION_STATE_FILE="${RELEASE_STAGE_DIR}/.publication-state"
MUSIC_BOX_SOURCE_CONTENT_MANIFEST="${RELEASE_BACKUP_DIR}/source-content-manifest.json"
export MUSIC_BOX_RELEASE_DIR="$RELEASE_STAGE_DIR"
export MUSIC_BOX_PUBLICATION_STATE_FILE
export MUSIC_BOX_SOURCE_CONTENT_MANIFEST
printf 'not-started\n' > "$MUSIC_BOX_PUBLICATION_STATE_FILE"
cp "$PKG" "${RELEASE_BACKUP_DIR}/package.json"
cp "$LOCKFILE" "${RELEASE_BACKUP_DIR}/package-lock.json"

if (( VERSION_ALREADY_COMMITTED == 1 )); then
  echo "Preparing Music Box Internal $NEXT from source commit $SOURCE_COMMIT (version already committed)"
else
  echo "Preparing Music Box Internal $CURRENT -> $NEXT from source commit $SOURCE_COMMIT"
  RELEASE_VERSION_MUTATED=1
  "$ENV_BIN" -u GH_TOKEN "$NPM_BIN" version \
    "$NEXT" --no-git-tag-version --allow-same-version --ignore-scripts
fi

if ! "$GIT_BIN" diff --cached --quiet; then
  echo "ERROR: Release preparation unexpectedly changed the Git index." >&2
  exit 1
fi
CHANGED_FILES="$("$GIT_BIN" diff --name-only | sort)"
if (( VERSION_ALREADY_COMMITTED == 1 )); then
  # Nothing may change: the committed tree is exactly what gets built.
  if [[ -n "$CHANGED_FILES" ]]; then
    echo "ERROR: The worktree must stay identical to HEAD when building an already-committed version." >&2
    printf 'Changed files:\n%s\n' "$CHANGED_FILES" >&2
    exit 1
  fi
elif [[ "$CHANGED_FILES" != $'package-lock.json\npackage.json' ]]; then
  echo "ERROR: Only package.json and package-lock.json may change during release preparation." >&2
  printf 'Changed files:\n%s\n' "$CHANGED_FILES" >&2
  exit 1
fi
if [[ "$("$GIT_BIN" rev-parse HEAD)" != "$SOURCE_COMMIT" ]]; then
  echo "ERROR: Source commit changed while the release was running." >&2
  exit 1
fi
cp "$PKG" "${RELEASE_BACKUP_DIR}/release-package.json"
cp "$LOCKFILE" "${RELEASE_BACKUP_DIR}/release-package-lock.json"

echo "Creating a detached clean release worktree from $SOURCE_COMMIT..."
"$GIT_BIN" worktree add --detach "$RELEASE_SOURCE_DIR" "$SOURCE_COMMIT"
cp "$PKG" "${RELEASE_SOURCE_DIR}/package.json"
cp "$LOCKFILE" "${RELEASE_SOURCE_DIR}/package-lock.json"
verify_isolated_source

cd "$RELEASE_SOURCE_DIR"
echo "Rebuilding dependencies from package-lock.json in the clean worktree..."
"$ENV_BIN" \
  -u GH_TOKEN \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  "$NPM_BIN" ci
verify_isolated_source

echo "Checking $NEXT against every stable published GitHub release..."
"$ENV_BIN" \
  -u APPLE_ID \
  -u APPLE_APP_SPECIFIC_PASSWORD \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  GH_TOKEN="$RELEASE_GH_TOKEN" "$NODE_BIN" \
  tests/publish-verified-release.js --check-version "$NEXT"

echo "Running the trusted test and vendor preflight in the clean worktree..."
"$ENV_BIN" \
  -u GH_TOKEN \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  "$NPM_BIN" test
"$ENV_BIN" \
  -u GH_TOKEN \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  "$NPM_BIN" run vendor:prepare
verify_isolated_source

echo "Binding first-party packaged content to a pre-build source manifest..."
"$ENV_BIN" \
  -u GH_TOKEN \
  -u APPLE_ID \
  -u APPLE_APP_SPECIFIC_PASSWORD \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  "$NODE_BIN" tests/release-artifact-gate.js \
  --write-source-manifest "$MUSIC_BOX_SOURCE_CONTENT_MANIFEST"

echo "Building and verifying isolated arm64 release v$NEXT..."
echo "No GitHub upload begins until every local verification passes."
MUSIC_BOX_RELEASE_DRIVER=1 "$ENV_BIN" -u GH_TOKEN \
  "$NPM_BIN" run release:build:internal
verify_isolated_source

echo "Publishing only the exact artifacts that passed the local gate..."
"$ENV_BIN" \
  -u APPLE_ID \
  -u APPLE_APP_SPECIFIC_PASSWORD \
  -u APPLE_KEYCHAIN_PROFILE \
  -u APPLE_KEYCHAIN \
  -u APPLE_API_KEY \
  -u APPLE_API_KEY_ID \
  -u APPLE_API_ISSUER \
  GH_TOKEN="$RELEASE_GH_TOKEN" "$NODE_BIN" \
  tests/publish-verified-release.js "$RELEASE_STAGE_DIR"

if [[ "$(publication_state)" != "published" ]]; then
  echo "ERROR: Publisher returned without a confirmed published state." >&2
  exit 1
fi
RELEASE_PUBLISHED=1

echo "Published verified arm64 release v$NEXT from $SOURCE_COMMIT"
echo "https://github.com/drummerisaiah15-eng/music-box-internal-releases/releases/tag/v$NEXT"
