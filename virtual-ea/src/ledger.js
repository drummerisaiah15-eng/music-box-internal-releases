'use strict';

// The commitment ledger.
//
// An EA is trusted because nothing dropped through. That is a bookkeeping
// property, not a personality trait, so it is implemented as bookkeeping: every
// promise made to or by the principal becomes a row, every row has an owner and
// a clock, and the clock decides when the assistant speaks up. Nothing here
// depends on the assistant "remembering" to check.
//
// The store is an append-only event log rather than a mutable table. A
// high-trust operator has to be able to answer "who changed this due date, and
// when" months later, and an event log answers that for free. State is a fold
// over the log.

const HOUR_MS = 60 * 60 * 1000;

// Lanes match the five areas of ownership the role is scoped to. A commitment
// that does not belong to one of them is a commitment nobody agreed this
// assistant would carry, so the lane is required rather than optional.
const LANES = Object.freeze([
  'executive',  // calendar, inbox, scheduling, travel
  'project',    // timelines, vendors, staff, documentation
  'finance',    // receipts, statements, filing, CPA requests
  'research',   // option comparison, verification, recommendations
  'systems',    // SOPs, workflows, automation
]);

const PRIORITIES = Object.freeze(['critical', 'high', 'normal', 'low']);

const STATUSES = Object.freeze([
  'open',      // live, this side is acting
  'waiting',   // live, blocked on a named third party
  'done',
  'dropped',   // deliberately abandoned, with a reason
]);

// Service levels. `acknowledgeHours` is how long the principal's counterparty
// waits before hearing *something* back; `resolveHours` is the actual promise.
// The split matters: most reputational damage comes from silence, not from
// slowness, so the assistant is measured on acknowledgement first.
const DEFAULT_SLA = Object.freeze({
  critical: Object.freeze({ acknowledgeHours: 1, resolveHours: 8, nudgeEveryHours: 8, escalateAfterNudges: 1 }),
  high: Object.freeze({ acknowledgeHours: 4, resolveHours: 48, nudgeEveryHours: 24, escalateAfterNudges: 2 }),
  normal: Object.freeze({ acknowledgeHours: 24, resolveHours: 120, nudgeEveryHours: 72, escalateAfterNudges: 2 }),
  low: Object.freeze({ acknowledgeHours: 72, resolveHours: 336, nudgeEveryHours: 168, escalateAfterNudges: 1 }),
});

const EVENT_TYPES = Object.freeze([
  'created',
  'updated',
  'acknowledged',   // counterparty has been told we have it
  'nudged',         // we chased the person we are waiting on
  'escalated',      // handed to the principal because chasing stopped working
  'completed',
  'dropped',
]);

class LedgerError extends Error {}

function fail(message) {
  throw new LedgerError(message);
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, field, { maxLength = 500 } = {}) {
  if (typeof value !== 'string') fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) fail(`${field} must not be empty`);
  if (trimmed.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function requireOneOf(value, allowed, field) {
  if (!allowed.includes(value)) {
    fail(`${field} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

// Timestamps are stored as ISO-8601 UTC strings. Storing epoch numbers would be
// smaller but unreadable in a log a human auditor (or a CPA) has to skim.
function requireInstant(value, field) {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) fail(`${field} must be a valid date`);
    return value.toISOString();
  }
  if (typeof value !== 'string') fail(`${field} must be an ISO-8601 string or Date`);
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail(`${field} must be a valid ISO-8601 timestamp`);
  return new Date(parsed).toISOString();
}

function optionalInstant(value, field) {
  if (value === undefined || value === null || value === '') return null;
  return requireInstant(value, field);
}

function toMillis(instant) {
  return instant === null ? null : Date.parse(instant);
}

function hoursBetween(fromInstant, toInstant) {
  return (Date.parse(toInstant) - Date.parse(fromInstant)) / HOUR_MS;
}

function slaFor(priority, overrides) {
  const base = DEFAULT_SLA[priority];
  if (!base) fail(`no SLA defined for priority ${priority}`);
  if (!overrides) return base;
  const custom = overrides[priority];
  if (!custom) return base;
  return { ...base, ...custom };
}

/**
 * Validate and normalise a new commitment. Throws rather than coercing: a
 * silently-defaulted due date is exactly the kind of quiet inaccuracy this role
 * exists to prevent.
 */
function normalizeCommitment(input, { now } = {}) {
  if (!isPlainObject(input)) fail('commitment must be an object');

  const createdAt = requireInstant(input.createdAt ?? now ?? new Date(), 'createdAt');
  const commitment = {
    id: requireString(input.id, 'id', { maxLength: 120 }),
    title: requireString(input.title, 'title'),
    lane: requireOneOf(input.lane, LANES, 'lane'),
    priority: requireOneOf(input.priority ?? 'normal', PRIORITIES, 'priority'),
    status: requireOneOf(input.status ?? 'open', STATUSES, 'status'),

    // `owner` is who must act next. `waitingOn` names the human being chased
    // when the owner is not us — an unnamed blocker is an excuse, not a status.
    owner: requireString(input.owner ?? 'ea', 'owner', { maxLength: 120 }),
    waitingOn: input.waitingOn ? requireString(input.waitingOn, 'waitingOn', { maxLength: 120 }) : null,

    // Provenance. Every row must be traceable to the message, meeting or
    // document that created the obligation, so the principal can audit any
    // claim the assistant makes back to its origin.
    source: requireString(input.source, 'source', { maxLength: 400 }),

    dueAt: optionalInstant(input.dueAt, 'dueAt'),
    createdAt,
    updatedAt: createdAt,
    acknowledgedAt: optionalInstant(input.acknowledgedAt, 'acknowledgedAt'),
    closedAt: null,
    closeReason: null,
    nudgeCount: 0,
    lastNudgedAt: optionalInstant(input.lastNudgedAt, 'lastNudgedAt'),
    escalated: false,
    notes: input.notes ? requireString(input.notes, 'notes', { maxLength: 4000 }) : null,
  };

  if (commitment.status === 'waiting' && !commitment.waitingOn) {
    fail('a waiting commitment must name who it is waiting on');
  }
  if (commitment.dueAt && toMillis(commitment.dueAt) < toMillis(commitment.createdAt)) {
    fail('dueAt must not precede createdAt');
  }
  return commitment;
}

function normalizeEvent(input) {
  if (!isPlainObject(input)) fail('event must be an object');
  const type = requireOneOf(input.type, EVENT_TYPES, 'event type');
  const at = requireInstant(input.at, 'event at');
  const event = { type, at, commitmentId: null, actor: requireString(input.actor ?? 'ea', 'actor', { maxLength: 120 }) };

  if (type === 'created') {
    event.commitment = normalizeCommitment(input.commitment, { now: at });
    event.commitmentId = event.commitment.id;
  } else {
    event.commitmentId = requireString(input.commitmentId, 'commitmentId', { maxLength: 120 });
    if (type === 'updated') {
      if (!isPlainObject(input.patch)) fail('updated event requires a patch object');
      event.patch = { ...input.patch };
    }
    if (type === 'dropped' || type === 'completed') {
      event.reason = input.reason ? requireString(input.reason, 'reason', { maxLength: 1000 }) : null;
    }
    if (type === 'nudged' || type === 'escalated') {
      event.channel = input.channel ? requireString(input.channel, 'channel', { maxLength: 80 }) : null;
    }
  }
  return event;
}

// Fields a later `updated` event is allowed to touch. Provenance (`id`,
// `source`, `createdAt`) and the derived counters are deliberately not in this
// list: rewriting where an obligation came from would defeat the point of
// keeping a log at all.
const PATCHABLE_FIELDS = Object.freeze([
  'title', 'lane', 'priority', 'status', 'owner', 'waitingOn', 'dueAt', 'notes',
]);

function applyPatch(commitment, patch, at) {
  const next = { ...commitment };
  for (const [key, value] of Object.entries(patch)) {
    if (!PATCHABLE_FIELDS.includes(key)) {
      fail(`field ${key} cannot be changed after creation`);
    }
    switch (key) {
      case 'title':
        next.title = requireString(value, 'title');
        break;
      case 'lane':
        next.lane = requireOneOf(value, LANES, 'lane');
        break;
      case 'priority':
        next.priority = requireOneOf(value, PRIORITIES, 'priority');
        break;
      case 'status':
        next.status = requireOneOf(value, STATUSES, 'status');
        break;
      case 'owner':
        next.owner = requireString(value, 'owner', { maxLength: 120 });
        break;
      case 'waitingOn':
        next.waitingOn = value ? requireString(value, 'waitingOn', { maxLength: 120 }) : null;
        break;
      case 'dueAt':
        next.dueAt = optionalInstant(value, 'dueAt');
        break;
      case 'notes':
        next.notes = value ? requireString(value, 'notes', { maxLength: 4000 }) : null;
        break;
      default:
        fail(`unhandled patch field ${key}`);
    }
  }
  if (next.status === 'waiting' && !next.waitingOn) {
    fail('a waiting commitment must name who it is waiting on');
  }
  next.updatedAt = at;
  return next;
}

/**
 * Fold an event log into current commitment state.
 *
 * Returns a Map keyed by commitment id, in insertion order, so callers get a
 * stable ordering without having to sort for display.
 */
function reduceEvents(events) {
  if (!Array.isArray(events)) fail('events must be an array');
  const state = new Map();

  for (const raw of events) {
    const event = normalizeEvent(raw);

    if (event.type === 'created') {
      if (state.has(event.commitmentId)) fail(`duplicate commitment id ${event.commitmentId}`);
      state.set(event.commitmentId, event.commitment);
      continue;
    }

    const current = state.get(event.commitmentId);
    if (!current) fail(`event references unknown commitment ${event.commitmentId}`);
    // Closed rows are immutable. Reopening is a new commitment with a new id
    // that cites the old one, which keeps the history of "we said this was
    // finished and it was not" visible instead of overwriting it.
    if (current.closedAt) fail(`commitment ${event.commitmentId} is already closed`);

    switch (event.type) {
      case 'updated':
        state.set(event.commitmentId, applyPatch(current, event.patch, event.at));
        break;
      case 'acknowledged':
        state.set(event.commitmentId, { ...current, acknowledgedAt: event.at, updatedAt: event.at });
        break;
      case 'nudged':
        state.set(event.commitmentId, {
          ...current,
          nudgeCount: current.nudgeCount + 1,
          lastNudgedAt: event.at,
          updatedAt: event.at,
        });
        break;
      case 'escalated':
        state.set(event.commitmentId, { ...current, escalated: true, updatedAt: event.at });
        break;
      case 'completed':
        state.set(event.commitmentId, {
          ...current,
          status: 'done',
          closedAt: event.at,
          closeReason: event.reason,
          updatedAt: event.at,
        });
        break;
      case 'dropped':
        // A drop without a stated reason is indistinguishable from forgetting,
        // which is the failure mode the ledger exists to make impossible.
        if (!event.reason) fail('dropping a commitment requires a reason');
        state.set(event.commitmentId, {
          ...current,
          status: 'dropped',
          closedAt: event.at,
          closeReason: event.reason,
          updatedAt: event.at,
        });
        break;
      default:
        fail(`unhandled event type ${event.type}`);
    }
  }
  return state;
}

/**
 * Decide what, if anything, this commitment needs right now.
 *
 * Every branch returns a `reason` written as a sentence the assistant can put
 * straight in front of the principal. Producing an explanation the human can
 * check is part of the output, not a debugging afterthought.
 */
function assess(commitment, now, { slaOverrides } = {}) {
  const at = requireInstant(now, 'now');
  const sla = slaFor(commitment.priority, slaOverrides);

  if (commitment.closedAt) {
    return {
      id: commitment.id,
      state: 'closed',
      urgency: 0,
      needsNudge: false,
      needsEscalation: false,
      hoursUntilDue: null,
      reason: `Closed ${commitment.status === 'done' ? 'complete' : 'dropped'} on ${commitment.closedAt.slice(0, 10)}.`,
    };
  }

  const ageHours = hoursBetween(commitment.createdAt, at);
  const hoursUntilDue = commitment.dueAt === null ? null : hoursBetween(at, commitment.dueAt);

  // Acknowledgement is checked before the due date because an unanswered
  // request is a live reputational problem even when its deadline is far off.
  //
  // It only applies while WE owe the reply. Once the status is `waiting` we
  // have demonstrably already engaged — we are the ones chasing — and reporting
  // "no reply sent" about our own outstanding request reads as a contradiction.
  const awaitingAcknowledgement = commitment.status === 'open'
    && commitment.acknowledgedAt === null
    && ageHours >= sla.acknowledgeHours;

  const sinceLastNudgeHours = commitment.lastNudgedAt === null
    ? ageHours
    : hoursBetween(commitment.lastNudgedAt, at);

  // We only chase when someone else holds the ball. Chasing ourselves is just
  // noise in the brief.
  const chasingSomeoneElse = commitment.status === 'waiting';
  const needsNudge = chasingSomeoneElse && sinceLastNudgeHours >= sla.nudgeEveryHours;
  const needsEscalation = chasingSomeoneElse
    && !commitment.escalated
    && commitment.nudgeCount >= sla.escalateAfterNudges;

  let state;
  let reason;
  if (hoursUntilDue !== null && hoursUntilDue < 0) {
    state = 'overdue';
    reason = `Overdue by ${formatDuration(-hoursUntilDue)}${commitment.waitingOn ? `; waiting on ${commitment.waitingOn}` : ''}.`;
  } else if (awaitingAcknowledgement) {
    state = 'unacknowledged';
    reason = `No reply sent in ${formatDuration(ageHours)}; the ${commitment.priority} standard is ${formatDuration(sla.acknowledgeHours)}.`;
  } else if (hoursUntilDue !== null && hoursUntilDue <= sla.acknowledgeHours) {
    state = 'due-now';
    reason = `Due in ${formatDuration(hoursUntilDue)}.`;
  } else if (needsEscalation) {
    state = 'stalled';
    reason = `${commitment.waitingOn} has not moved after ${commitment.nudgeCount} ${commitment.nudgeCount === 1 ? 'chase' : 'chases'}; needs your weight behind it.`;
  } else if (needsNudge) {
    state = 'chase-due';
    reason = `${commitment.waitingOn} last chased ${formatDuration(sinceLastNudgeHours)} ago.`;
  } else if (hoursUntilDue !== null && hoursUntilDue <= sla.resolveHours) {
    state = 'due-soon';
    reason = `Due in ${formatDuration(hoursUntilDue)}.`;
  } else {
    state = 'on-track';
    reason = commitment.dueAt
      ? `Due ${commitment.dueAt.slice(0, 10)}; no action needed today.`
      : 'No deadline set; no action needed today.';
  }

  return {
    id: commitment.id,
    state,
    urgency: urgencyScore({ commitment, state, hoursUntilDue, needsEscalation }),
    needsNudge,
    needsEscalation,
    hoursUntilDue,
    reason,
  };
}

// Ordering is deterministic and explainable on purpose. A principal who is
// "particular about accuracy" will eventually ask why item four is above item
// five, and the answer has to be a rule rather than a vibe.
const STATE_WEIGHT = Object.freeze({
  overdue: 1000,
  stalled: 850,
  'due-now': 800,
  unacknowledged: 700,
  'chase-due': 500,
  'due-soon': 300,
  'on-track': 50,
  closed: 0,
});

const PRIORITY_WEIGHT = Object.freeze({ critical: 400, high: 200, normal: 80, low: 20 });

function urgencyScore({ commitment, state, hoursUntilDue, needsEscalation }) {
  if (commitment.closedAt) return 0;
  let score = STATE_WEIGHT[state] + PRIORITY_WEIGHT[commitment.priority];
  if (needsEscalation) score += 120;
  if (hoursUntilDue !== null) {
    // Lateness keeps accumulating so a week-old miss outranks this morning's,
    // but logarithmically, so one ancient item cannot bury everything current.
    const overdueHours = Math.max(0, -hoursUntilDue);
    score += Math.min(300, Math.round(40 * Math.log2(1 + overdueHours)));
  }
  return score;
}

function formatDuration(hours) {
  const abs = Math.abs(hours);
  if (abs < 1) {
    const minutes = Math.max(1, Math.round(abs * 60));
    return `${minutes} min`;
  }
  if (abs < 48) {
    const rounded = Math.round(abs);
    return `${rounded} ${rounded === 1 ? 'hour' : 'hours'}`;
  }
  const days = Math.round(abs / 24);
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

/**
 * The working queue: everything live, most urgent first, each row carrying the
 * sentence explaining why it sits where it does.
 */
function triageQueue(commitments, now, options = {}) {
  const rows = [];
  for (const commitment of commitments.values ? commitments.values() : commitments) {
    const verdict = assess(commitment, now, options);
    if (verdict.state === 'closed') continue;
    rows.push({ commitment, ...verdict });
  }
  // Ties break on id so two runs over identical data produce identical output —
  // a brief that reshuffles itself between runs is a brief nobody trusts.
  rows.sort((a, b) => (b.urgency - a.urgency) || a.commitment.id.localeCompare(b.commitment.id));
  return rows;
}

/**
 * Everything that has gone quiet and needs a chase, with the escalation flag
 * set once chasing has demonstrably stopped working.
 */
function followUpPlan(commitments, now, options = {}) {
  return triageQueue(commitments, now, options)
    .filter(row => row.needsNudge || row.needsEscalation)
    .map(row => ({
      id: row.commitment.id,
      title: row.commitment.title,
      waitingOn: row.commitment.waitingOn,
      action: row.needsEscalation ? 'escalate' : 'nudge',
      attempt: row.commitment.nudgeCount + 1,
      reason: row.reason,
    }));
}

module.exports = {
  LANES,
  PRIORITIES,
  STATUSES,
  EVENT_TYPES,
  DEFAULT_SLA,
  LedgerError,
  normalizeCommitment,
  normalizeEvent,
  reduceEvents,
  assess,
  triageQueue,
  followUpPlan,
  formatDuration,
};
