'use strict';

// Unattended fetch orchestration.
//
// The engine still does not talk to Google, and deliberately so: OAuth, token
// refresh and a vendor SDK are a dependency tree and an auth surface that
// cannot be tested offline, and the connectors already do that work. What was
// missing was a way to run the fetch when nobody is sitting there.
//
// So a fetcher is any command that prints JSON records to stdout. Claude
// running headlessly is one. A shell script hitting an API is another. A
// watched folder that a client drops statements into is a third, and needs no
// credentials at all. This module owns the part that is genuinely hard and can
// be made deterministic: when each source is due, what window to ask for, and
// what a failure means.
//
// The rule everything here serves: **a fetch that failed must leave no trace
// that it succeeded.** The watermark does not advance, so the next run asks for
// the same period again and nothing is silently skipped. A gap in a
// reconciliation caused by a fetch that quietly failed three weeks ago is
// exactly the kind of error this product exists not to make.

const { LedgerError } = require('./ledger');
const { COLLECTION_NAMES } = require('./sync');

class FetchError extends LedgerError {}

function fail(message) {
  throw new FetchError(message);
}

const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const DEFAULTS = Object.freeze({
  everyMinutes: 60,
  // Re-ask for a little before the last success. Sources backdate: an email
  // arrives with yesterday's timestamp, a calendar edit changes an event that
  // already passed. Asking only for "since the last run" misses those forever,
  // and the merge is idempotent so the overlap costs nothing.
  overlapMinutes: 120,
  lookbackDays: 7,
  horizonDays: 14,
  timeoutSeconds: 120,
  maxBackoffMinutes: 6 * 60,
});

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireInstant(value, field) {
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : value);
  if (Number.isNaN(parsed)) fail(`${field} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

function positiveNumber(value, field, fallback) {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${field} must be a positive number`);
  return number;
}

/**
 * Validate one source's configuration.
 *
 * `command` is an argv array, never a shell string, and it is never taken from
 * anywhere but the workspace's own config file. Fetched content cannot
 * influence what gets executed, and there is no shell to inject into.
 */
function normalizeSource(name, raw) {
  if (!isPlainObject(raw)) fail(`fetcher "${name}" must be an object`);
  if (!COLLECTION_NAMES.includes(raw.collection)) {
    fail(`fetcher "${name}" needs a collection: ${COLLECTION_NAMES.join(', ')}`);
  }

  const kind = raw.kind ?? (raw.directory ? 'file-drop' : 'command');
  if (!['command', 'file-drop'].includes(kind)) {
    fail(`fetcher "${name}" has unknown kind "${kind}"; expected command or file-drop`);
  }

  const source = {
    name,
    kind,
    collection: raw.collection,
    mode: raw.mode ?? 'incremental',
    enabled: raw.enabled !== false,
    everyMinutes: positiveNumber(raw.everyMinutes, `${name}.everyMinutes`, DEFAULTS.everyMinutes),
    overlapMinutes: positiveNumber(raw.overlapMinutes, `${name}.overlapMinutes`, DEFAULTS.overlapMinutes),
    lookbackDays: positiveNumber(raw.lookbackDays, `${name}.lookbackDays`, DEFAULTS.lookbackDays),
    horizonDays: positiveNumber(raw.horizonDays, `${name}.horizonDays`, DEFAULTS.horizonDays),
    timeoutSeconds: positiveNumber(raw.timeoutSeconds, `${name}.timeoutSeconds`, DEFAULTS.timeoutSeconds),
    maxBackoffMinutes: positiveNumber(raw.maxBackoffMinutes, `${name}.maxBackoffMinutes`, DEFAULTS.maxBackoffMinutes),
  };

  if (!['full', 'incremental'].includes(source.mode)) {
    fail(`fetcher "${name}" mode must be "full" or "incremental"`);
  }
  // Only a source that returns its complete current state may conclude a record
  // was withdrawn, and a windowed fetch never does. Letting the two combine
  // would mark everything outside the window as gone on the first run.
  if (source.mode === 'full' && source.collection === 'statements') {
    fail(`fetcher "${name}": statements are always incremental — an export covers a period, not the whole file`);
  }

  if (kind === 'command') {
    if (!Array.isArray(raw.command) || raw.command.length === 0) {
      fail(`fetcher "${name}" needs a command as an array of arguments, e.g. ["claude", "-p", "..."]`);
    }
    for (const argument of raw.command) {
      if (typeof argument !== 'string') fail(`fetcher "${name}" command arguments must all be strings`);
    }
    source.command = [...raw.command];
    source.cwd = raw.cwd ? String(raw.cwd) : null;
  } else {
    if (typeof raw.directory !== 'string' || !raw.directory.trim()) {
      fail(`fetcher "${name}" needs a directory to watch`);
    }
    source.directory = raw.directory.trim();
    source.account = raw.account ? String(raw.account) : name;
    source.entity = raw.entity ? String(raw.entity) : null;
    source.dateFormat = raw.dateFormat ? String(raw.dateFormat) : null;
    // Imported files are moved aside rather than deleted. A statement that was
    // read wrongly has to be re-readable, and a deleted one is not.
    source.archiveTo = raw.archiveTo ? String(raw.archiveTo) : 'imported';
  }
  return source;
}

function normalizeConfig(raw) {
  if (!isPlainObject(raw)) fail('fetchers config must be an object');
  const sources = raw.sources ?? {};
  if (!isPlainObject(sources)) fail('fetchers config needs a "sources" object');
  return Object.entries(sources).map(([name, value]) => normalizeSource(name, value));
}

function stateFor(state, name) {
  return state?.sources?.[name] ?? null;
}

/**
 * The period to ask this source for.
 *
 * Anchored on the last *successful* fetch, never the last attempt, so a run of
 * failures widens the window instead of leaving a hole in the middle of it.
 */
function fetchWindow(source, state, now) {
  const at = requireInstant(now, 'now');
  const record = stateFor(state, source.name);
  const lastSuccess = record?.lastSuccessAt ? Date.parse(record.lastSuccessAt) : null;

  const floor = Date.parse(at) - source.lookbackDays * DAY_MS;
  const since = lastSuccess === null
    ? floor
    : Math.max(floor, lastSuccess - source.overlapMinutes * MINUTE_MS);

  // Calendars are the one thing fetched forwards: today's brief needs the
  // fortnight ahead, not the fortnight behind.
  const until = source.collection === 'calendar'
    ? Date.parse(at) + source.horizonDays * DAY_MS
    : Date.parse(at);

  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    firstRun: lastSuccess === null,
  };
}

/**
 * When this source may next be attempted.
 *
 * Consecutive failures back off exponentially and cap, so a fetcher that is
 * broken — a revoked token, a renamed folder — stops hammering every minute and
 * stops burying the log, without ever being silently given up on.
 */
function nextAttemptAt(source, state) {
  const record = stateFor(state, source.name);
  if (!record?.lastAttemptAt) return null;               // never run: due now
  const failures = record.consecutiveFailures ?? 0;
  const backoff = failures === 0
    ? source.everyMinutes
    : Math.min(source.everyMinutes * (2 ** failures), source.maxBackoffMinutes);
  return new Date(Date.parse(record.lastAttemptAt) + backoff * MINUTE_MS).toISOString();
}

/**
 * Which sources are due, and why each other one is not.
 *
 * The skipped list carries a reason so `fetch --all` that does nothing can say
 * why, rather than looking broken.
 */
function duePlan(sources, state, now, { force = false, only = null } = {}) {
  const at = requireInstant(now, 'now');
  const due = [];
  const skipped = [];

  for (const source of sources) {
    // A source the caller did not ask for was not skipped — it was never in
    // scope. Reporting it pushes the line they actually wanted off the top.
    if (only && source.name !== only && source.collection !== only) continue;
    if (!source.enabled) {
      skipped.push({ name: source.name, reason: 'disabled in config' });
      continue;
    }
    const next = nextAttemptAt(source, state);
    if (!force && next && Date.parse(next) > Date.parse(at)) {
      const record = stateFor(state, source.name);
      const failures = record?.consecutiveFailures ?? 0;
      skipped.push({
        name: source.name,
        reason: failures > 0
          ? `backing off after ${failures} failure${failures === 1 ? '' : 's'}; next attempt ${next}`
          : `not due until ${next}`,
      });
      continue;
    }
    due.push({ source, window: fetchWindow(source, state, at) });
  }
  return { due, skipped };
}

/**
 * Turn a fetcher's raw output into records, or a failure that says what to fix.
 *
 * Fetchers are written by whoever operates the service and will misbehave in
 * ordinary ways — printing a log line before the JSON, timing out, emitting an
 * object instead of an array. Each of those gets a message naming the fix
 * rather than a stack trace.
 */
function interpretOutput({ status, stdout, stderr, timedOut, error }) {
  if (error) {
    return { ok: false, reason: `could not run the fetcher: ${error}` };
  }
  if (timedOut) {
    return { ok: false, reason: 'the fetcher timed out — raise timeoutSeconds or narrow the window' };
  }
  if (status !== 0) {
    const detail = (stderr || '').trim().split('\n').slice(-3).join(' ').slice(0, 400);
    return { ok: false, reason: `the fetcher exited ${status}${detail ? `: ${detail}` : ''}` };
  }

  const text = (stdout ?? '').trim();
  if (!text) {
    // A source with genuinely nothing new is normal and is a success, not a
    // failure — otherwise a quiet day would trigger backoff.
    return { ok: true, records: [] };
  }

  const parsed = extractJsonArray(text);
  if (!parsed.ok) return parsed;
  return { ok: true, records: parsed.records };
}

/**
 * Pull the records array out of a fetcher's stdout.
 *
 * Tolerates a preamble, because a command that logs a line before its JSON is
 * the single most common way a fetcher is written by hand, and failing on it
 * would send someone debugging their credentials instead of their `echo`.
 */
function extractJsonArray(text) {
  const attempts = [text];
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start > 0 && end > start) attempts.push(text.slice(start, end + 1));

  for (const candidate of attempts) {
    let value;
    try {
      value = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (Array.isArray(value)) return { ok: true, records: value };
    if (isPlainObject(value) && Array.isArray(value.records)) return { ok: true, records: value.records };
    return {
      ok: false,
      reason: 'the fetcher printed JSON that is not an array of records '
        + '(expected [ {...}, {...} ], or { "records": [...] })',
    };
  }
  return {
    ok: false,
    reason: `the fetcher printed something that is not JSON: ${text.slice(0, 200)}`,
  };
}

/**
 * Record what an attempt did.
 *
 * `lastSuccessAt` moves only on success. That single rule is what guarantees a
 * failed fetch leaves no gap: the next window still starts where the last good
 * one ended.
 */
function recordAttempt(state, { source, at, ok, reason = null, counts = null, window = null }) {
  const when = requireInstant(at, 'at');
  const next = isPlainObject(state) ? { ...state } : {};
  next.fetchers = { ...(next.fetchers ?? {}) };
  const previous = next.fetchers[source.name] ?? {};

  next.fetchers[source.name] = {
    collection: source.collection,
    lastAttemptAt: when,
    lastSuccessAt: ok ? when : (previous.lastSuccessAt ?? null),
    lastWindow: window,
    consecutiveFailures: ok ? 0 : (previous.consecutiveFailures ?? 0) + 1,
    lastError: ok ? null : reason,
    lastCounts: ok ? counts : (previous.lastCounts ?? null),
  };
  return next;
}

/**
 * Which sources have gone quiet.
 *
 * A stale calendar and an empty one produce the same brief, and only one of
 * them is real. This is what tells them apart.
 */
function healthReport(sources, state, now) {
  const at = Date.parse(requireInstant(now, 'now'));
  return sources.map(source => {
    const record = state?.fetchers?.[source.name] ?? null;
    const lastSuccess = record?.lastSuccessAt ? Date.parse(record.lastSuccessAt) : null;
    const ageMinutes = lastSuccess === null ? null : Math.round((at - lastSuccess) / MINUTE_MS);
    // Two missed intervals is a hiccup; three is a fetcher that has stopped
    // working and a brief that has quietly been wrong since.
    const stale = lastSuccess === null || ageMinutes > source.everyMinutes * 3;

    return {
      name: source.name,
      collection: source.collection,
      enabled: source.enabled,
      lastSuccessAt: record?.lastSuccessAt ?? null,
      ageMinutes,
      consecutiveFailures: record?.consecutiveFailures ?? 0,
      lastError: record?.lastError ?? null,
      nextAttemptAt: nextAttemptAt(source, { sources: state?.fetchers ?? {} }),
      stale: source.enabled && stale,
      note: !source.enabled
        ? 'disabled'
        : lastSuccess === null
          ? 'has never fetched successfully'
          : stale
            ? `last success ${formatAge(ageMinutes)} ago, expected every ${formatAge(source.everyMinutes)}`
            : `healthy, last success ${formatAge(ageMinutes)} ago`,
    };
  });
}

function formatAge(minutes) {
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) {
    const hours = Math.round(minutes / 60);
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(minutes / (60 * 24));
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * Substitute the window into a fetcher's arguments.
 *
 * Values are ISO timestamps this module generated, and the command is executed
 * as an argv array with no shell, so there is nothing here for a hostile value
 * to escape into even if one could reach this.
 */
function renderCommand(source, window) {
  const values = {
    '{{since}}': window.since,
    '{{until}}': window.until,
    '{{collection}}': source.collection,
    '{{source}}': source.name,
    '{{mode}}': source.mode,
  };
  return source.command.map(argument =>
    Object.entries(values).reduce((text, [token, value]) => text.split(token).join(value), argument));
}

function fetchEnvironment(source, window) {
  return {
    AI_EA_SINCE: window.since,
    AI_EA_UNTIL: window.until,
    AI_EA_COLLECTION: source.collection,
    AI_EA_SOURCE: source.name,
    AI_EA_MODE: source.mode,
  };
}

module.exports = {
  FetchError,
  DEFAULTS,
  normalizeSource,
  normalizeConfig,
  fetchWindow,
  nextAttemptAt,
  duePlan,
  interpretOutput,
  extractJsonArray,
  recordAttempt,
  healthReport,
  renderCommand,
  fetchEnvironment,
  formatAge,
};
