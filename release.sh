#!/usr/bin/env bash
# Music Box Internal — one-command release script
# Usage: ./release.sh           (auto-bumps patch: 1.0.3 → 1.0.4)
#        ./release.sh minor     (bumps minor:       1.0.3 → 1.1.0)
#        ./release.sh major     (bumps major:       1.0.3 → 2.0.0)
#        ./release.sh 1.2.0     (sets exact version)

set -e

# Load env vars from shell config so this works without pre-exporting
[ -f ~/.zshrc ] && source ~/.zshrc 2>/dev/null || true
[ -f ~/.zprofile ] && source ~/.zprofile 2>/dev/null || true

ELECTRON_DIR="$(cd "$(dirname "$0")" && pwd)"
PKG="$ELECTRON_DIR/package.json"
SOURCE_HTML="$ELECTRON_DIR/index.html"
DIST_HTML="$ELECTRON_DIR/dist/mac/Music Box Internal.app/Contents/Resources/index.html"

# ── 1. Read current version ──────────────────────────────────────────────────
CURRENT=$(node -p "require('$PKG').version")
IFS='.' read -r MAJOR MINOR PATCH <<< "$CURRENT"

# ── 2. Compute next version ──────────────────────────────────────────────────
BUMP="${1:-patch}"
case "$BUMP" in
  major)        NEXT="$((MAJOR + 1)).0.0" ;;
  minor)        NEXT="${MAJOR}.$((MINOR + 1)).0" ;;
  patch)        NEXT="${MAJOR}.${MINOR}.$((PATCH + 1))" ;;
  [0-9]*)       NEXT="$BUMP" ;;   # explicit version passed
  *)
    echo "❌  Unknown bump type: $BUMP  (use patch|minor|major|x.y.z)"
    exit 1 ;;
esac

echo ""
echo "📦  Music Box Internal  $CURRENT  →  $NEXT"
echo ""

# ── 3. Bump version in package.json ─────────────────────────────────────────
node -e "
  const fs = require('fs');
  const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
  pkg.version = '$NEXT';
  fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
"
echo "✅  package.json updated to $NEXT"

# ── 4. (Removed) dist→source sync was wiping source edits — source is the master ──
echo "ℹ️   Using source index.html as-is (source is always the master)"

# ── 5. Check env vars ────────────────────────────────────────────────────────
MISSING=()
[ -z "$APPLE_ID" ]                   && MISSING+=("APPLE_ID")
[ -z "$APPLE_APP_SPECIFIC_PASSWORD" ] && MISSING+=("APPLE_APP_SPECIFIC_PASSWORD")
[ -z "$GH_TOKEN" ]                   && MISSING+=("GH_TOKEN")

if [ ${#MISSING[@]} -gt 0 ]; then
  echo ""
  echo "❌  Missing env vars: ${MISSING[*]}"
  echo "    Add them to ~/.zshrc and run: source ~/.zshrc"
  echo "    Then re-run: ./release.sh"
  # Roll back version bump
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$PKG', 'utf8'));
    pkg.version = '$CURRENT';
    fs.writeFileSync('$PKG', JSON.stringify(pkg, null, 2) + '\n');
  "
  exit 1
fi

echo "✅  Env vars present"
echo ""

# ── 6. Build, sign, notarize, publish ───────────────────────────────────────
cd "$ELECTRON_DIR"
echo "🚀  Building v$NEXT and publishing to GitHub…"
echo ""
npm run publish

echo ""
echo "🎉  v$NEXT published!"
echo "    https://github.com/drummerisaiah15-eng/music-box-internal-releases/releases/tag/v$NEXT"
