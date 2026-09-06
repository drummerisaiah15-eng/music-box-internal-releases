'use strict';

// The sync merge engine.
//
// Pulling records out of Gmail or Google Calendar is the easy half and it is
// deliberately not done here — that needs network, auth and a live connector,
// none of which can be tested or replayed. Fetching belongs to whatever holds
// the connector. This module owns the half that is genuinely hard and can be
// made deterministic: deciding what a freshly fetched batch means when set
// against what the workspace already holds.
//
// The rule everything else serves: a re-sync must never destroy human work. If
// someone categorised a receipt as `equipment` and recorded who was at a
// dinner, no amount of re-fetching may overwrite it. Field ownership is
// therefore declared per collection rather than inferred, and locally-owned
// fields are written once on insert and never again.

const { LedgerError } = require('./ledger');
const finance = require('./finance');
const brief = require('./brief');

class SyncError extends LedgerError {}

function fail(message) {
  throw new SyncError(message);
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireInstant(value, field) {
  const parsed = Date.parse(value instanceof Date ? value.toISOString() : value);
  if (Number.isNaN(parsed)) fail(`${field} must be a valid timestamp`);
  return new Date(parsed).toISOString();
}

/**
 * What each syncable collection is, and — the important part — who owns which
 * of its fields.
 *
 * `localFields` are the judgement calls a person makes. They are merged
 * three-way: the value the remote last supplied is recorded as a baseline, so
 * a field a human has changed since can be told apart from one the feed simply
 * populated. A human's value always wins; an untouched field takes the feed's
 * newer value, since nobody has expressed a preference to override.
 *
 * `materialFields` are remote-owned, but a change to one after a person has
 * done that judgement work is worth interrupting them about: an amount that
 * moves after a receipt was filed means one of the two readings is wrong.
 */
const COLLECTIONS = Object.freeze({
  calendar: {
    file: 'calendar.json',
    // A calendar event is entirely the remote's to describe.
    localFields: [],
    materialFields: ['title', 'start', 'end', 'location'],
    validate: (record) => brief.normalizeEvent(record, 0),
  },
  documents: {
    file: 'documents.json',
    // Everything a human decides about a receipt lives here. Losing any of it
    // to a re-sync would mean re-doing the year's classification.
    localFields: ['category', 'businessPurpose', 'attendees', 'entity', 'taxYear', 'reference'],
    materialFields: ['amountCents', 'date', 'counterparty', 'docType'],
    validate: (record) => finance.normalizeExpenseDocument(record, 0),
  },
  statements: {
    file: 'statements.json',
    // A statement line is what the bank says happened. Nothing here is ours.
    localFields: [],
    materialFields: ['amountCents', 'date', 'description'],
    validate: (record) => finance.normalizeStatementLine(record, 0),
  },
});

const COLLECTION_NAMES = Object.freeze(Object.keys(COLLECTIONS));

function collectionSpec(name) {
  const spec = COLLECTIONS[name];
  if (!spec) fail(`unknown collection "${name}"; expected one of ${COLLECTION_NAMES.join(', ')}`);
  return spec;
}

// Sync bookkeeping lives under one reserved key so it cannot collide with a
// real field, and so the domain modules — which build fresh objects from the
// fields they know — ignore it entirely.
const SYNC_KEY = '_sync';

function syncKeyOf(source, sourceId) {
  return `${source} ${sourceId}`;
}

function slugId(source, sourceId) {
  return `${source}-${sourceId}`.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/-+/g, '-').slice(0, 120);
}

/**
 * Validate and stamp one incoming record.
 *
 * Returns either `{ ok: true, record }` or `{ ok: false, reason }`. A single
 * malformed row must not abort a sync of two hundred good ones, so failures are
 * collected and reported rather than thrown.
 */
function prepareIncoming(raw, { collection, source, index }) {
  if (!isPlainObject(raw)) {
    return { ok: false, sourceId: `#${index}`, reason: 'record is not an object' };
  }
  const sourceId = raw.sourceId ?? raw.id;
  if (typeof sourceId !== 'string' || !sourceId.trim()) {
    return {
      ok: false,
      sourceId: `#${index}`,
      reason: 'record has no sourceId — a synced record must be identifiable at its origin',
    };
  }

  const spec = collectionSpec(collection);
  // Strip incoming sync metadata: provenance is ours to assign, never something
  // a fetched payload gets to claim about itself.
  const { [SYNC_KEY]: ignoredMeta, sourceId: ignoredSourceId, ...fields } = raw;
  const candidate = { ...fields, id: raw.id ?? slugId(source, sourceId) };

  try {
    spec.validate(candidate);
  } catch (error) {
    return { ok: false, sourceId: sourceId.trim(), reason: error.message };
  }
  return { ok: true, sourceId: sourceId.trim(), record: candidate };
}

/**
 * Merge a fetched batch into what the workspace already holds.
 *
 * `mode` matters more than it looks. Only a `full` sync — one where the batch
 * is the complete current state of that source — can conclude that a record's
 * absence means it was withdrawn. An `incremental` sync fetches only what
 * changed, so absence means nothing at all and deletions are undetectable.
 * Getting this wrong would silently empty a calendar.
 */
function merge({ collection, existing = [], incoming = [], source, now, mode = 'incremental' }) {
  const spec = collectionSpec(collection);
  if (typeof source !== 'string' || !source.trim()) fail('merge requires a source name');
  if (!['full', 'incremental'].includes(mode)) fail(`mode must be "full" or "incremental", got "${mode}"`);
  if (!Array.isArray(existing) || !Array.isArray(incoming)) fail('existing and incoming must be arrays');
  const at = requireInstant(now, 'now');

  const report = {
    collection,
    source,
    mode,
    at,
    added: [],
    updated: [],
    unchanged: [],
    withdrawn: [],
    restored: [],
    conflicts: [],
    rejected: [],
    untouched: 0,
  };

  // Records this source does not own — hand-added rows, or rows from another
  // connector — pass through completely untouched.
  const ours = new Map();
  const theirs = [];
  for (const record of existing) {
    const meta = record?.[SYNC_KEY];
    if (meta && meta.source === source && typeof meta.sourceId === 'string') {
      ours.set(syncKeyOf(source, meta.sourceId), record);
    } else {
      theirs.push(record);
    }
  }
  report.untouched = theirs.length;

  const seen = new Set();
  const merged = [];

  incoming.forEach((raw, index) => {
    const prepared = prepareIncoming(raw, { collection, source, index });
    if (!prepared.ok) {
      report.rejected.push({ sourceId: prepared.sourceId, reason: prepared.reason });
      return;
    }

    const key = syncKeyOf(source, prepared.sourceId);
    if (seen.has(key)) {
      // The same record twice in one batch is a fetch bug, not a duplicate
      // charge. Say so rather than writing it twice.
      report.rejected.push({ sourceId: prepared.sourceId, reason: 'appears more than once in this batch' });
      return;
    }
    seen.add(key);

    const current = ours.get(key);
    if (!current) {
      const insertBaseline = {};
      for (const field of spec.localFields) {
        insertBaseline[field] = Object.hasOwn(prepared.record, field) ? prepared.record[field] : undefined;
      }
      merged.push({
        ...prepared.record,
        [SYNC_KEY]: {
          source,
          sourceId: prepared.sourceId,
          firstSeenAt: at,
          lastSeenAt: at,
          withdrawnAt: null,
          localBaseline: insertBaseline,
        },
      });
      report.added.push(prepared.sourceId);
      return;
    }

    // Remote-owned fields refresh. Locally-owned fields are merged three-way
    // against what the remote last supplied.
    const next = { ...prepared.record };
    const baseline = current[SYNC_KEY].localBaseline ?? {};
    const nextBaseline = {};
    const edited = [];

    for (const field of spec.localFields) {
      const remoteValue = Object.hasOwn(prepared.record, field) ? prepared.record[field] : undefined;
      nextBaseline[field] = remoteValue;

      const currentValue = Object.hasOwn(current, field) ? current[field] : undefined;
      const humanEdited = JSON.stringify(currentValue) !== JSON.stringify(baseline[field]);

      if (humanEdited) {
        // Somebody decided this. Nothing upstream gets to overrule it.
        edited.push(field);
        if (currentValue !== undefined) next[field] = currentValue;
        else delete next[field];
      } else if (remoteValue !== undefined) {
        // Untouched, so take the feed's newer reading — extraction improves.
        next[field] = remoteValue;
      } else if (currentValue !== undefined) {
        next[field] = currentValue;
      }
    }
    next.id = current.id;

    const changedMaterial = spec.materialFields.filter(field =>
      Object.hasOwn(prepared.record, field)
      && JSON.stringify(current[field]) !== JSON.stringify(prepared.record[field]));

    // A material change underneath somebody's judgement work needs eyes. A
    // material change to a record nobody has touched is just the feed catching
    // up with itself, and interrupting over it would train them to ignore this.
    const humanTouched = edited.length > 0;

    if (changedMaterial.length > 0 && humanTouched) {
      report.conflicts.push({
        sourceId: prepared.sourceId,
        id: current.id,
        yourFields: edited,
        fields: changedMaterial.map(field => ({
          field,
          was: current[field],
          now: prepared.record[field],
        })),
        note: 'changed at the source after it had been classified here — confirm which reading is right',
      });
    }

    const wasWithdrawn = Boolean(current[SYNC_KEY].withdrawnAt);
    if (wasWithdrawn) report.restored.push(prepared.sourceId);

    merged.push({
      ...next,
      [SYNC_KEY]: { ...current[SYNC_KEY], lastSeenAt: at, withdrawnAt: null, localBaseline: nextBaseline },
    });

    if (changedMaterial.length > 0 || wasWithdrawn) report.updated.push(prepared.sourceId);
    else report.unchanged.push(prepared.sourceId);
  });

  // Anything this source owned but did not send back.
  for (const [key, record] of ours) {
    if (seen.has(key)) continue;
    if (mode === 'full') {
      // Marked, never deleted. A cancelled meeting that silently vanishes takes
      // its history with it, and a receipt that vanishes is a missing document
      // nobody will ever go looking for.
      const alreadyWithdrawn = Boolean(record[SYNC_KEY].withdrawnAt);
      merged.push({
        ...record,
        [SYNC_KEY]: { ...record[SYNC_KEY], withdrawnAt: record[SYNC_KEY].withdrawnAt ?? at },
      });
      if (!alreadyWithdrawn) report.withdrawn.push(record[SYNC_KEY].sourceId);
    } else {
      merged.push(record);
    }
  }

  // Deterministic order so the file does not churn between syncs and a diff
  // shows only what actually changed.
  const records = [...theirs, ...merged].sort((a, b) => {
    const aKey = `${a?.date ?? a?.start ?? ''}${a?.id ?? ''}`;
    const bKey = `${b?.date ?? b?.start ?? ''}${b?.id ?? ''}`;
    return aKey.localeCompare(bKey);
  });

  return { records, report };
}

/**
 * Live records only — everything the rest of the engine should reason about.
 *
 * Withdrawn rows stay in the file as history but must not reach a
 * reconciliation or a brief, where they would read as current.
 */
function liveRecords(records) {
  if (!Array.isArray(records)) return [];
  return records.filter(record => !record?.[SYNC_KEY]?.withdrawnAt);
}

/**
 * Update the per-source watermark, so the next fetch knows where to resume.
 */
function recordSyncState(state, { source, collection, at, mode, report, cursor = null }) {
  const next = isPlainObject(state) ? { ...state } : {};
  next.sources = { ...(next.sources ?? {}) };
  next.sources[source] = {
    collection,
    lastSyncAt: requireInstant(at, 'at'),
    lastMode: mode,
    cursor,
    lastCounts: report
      ? {
        added: report.added.length,
        updated: report.updated.length,
        unchanged: report.unchanged.length,
        withdrawn: report.withdrawn.length,
        rejected: report.rejected.length,
        conflicts: report.conflicts.length,
      }
      : null,
  };
  return next;
}

function summariseReport(report) {
  const parts = [
    `${report.added.length} added`,
    `${report.updated.length} updated`,
    `${report.unchanged.length} unchanged`,
  ];
  if (report.withdrawn.length) parts.push(`${report.withdrawn.length} withdrawn`);
  if (report.restored.length) parts.push(`${report.restored.length} restored`);
  if (report.untouched) parts.push(`${report.untouched} left alone`);

  const lines = [`${report.collection} <- ${report.source} (${report.mode}): ${parts.join(', ')}.`];

  if (report.conflicts.length > 0) {
    lines.push(
      `${report.conflicts.length} need${report.conflicts.length === 1 ? 's' : ''} your eyes `
      + '— changed at the source after being classified here:',
    );
    for (const conflict of report.conflicts) {
      for (const change of conflict.fields) {
        lines.push(`  - ${conflict.id}: ${change.field} was ${JSON.stringify(change.was)}, now ${JSON.stringify(change.now)}`);
      }
    }
  }
  if (report.rejected.length > 0) {
    lines.push(`${report.rejected.length} rejected:`);
    for (const rejected of report.rejected) {
      lines.push(`  - ${rejected.sourceId}: ${rejected.reason}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SyncError,
  COLLECTIONS,
  COLLECTION_NAMES,
  SYNC_KEY,
  prepareIncoming,
  merge,
  liveRecords,
  recordSyncState,
  summariseReport,
};
