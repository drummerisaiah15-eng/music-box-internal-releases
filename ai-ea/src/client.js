'use strict';

// Client profile and authority model.
//
// This is the part that makes the product sellable rather than merely clever.
// A client is not buying task execution; they are buying task execution they do
// not have to supervise. That requires the boundaries of the assistant's
// authority to be written down, machine-checked before an outbound action, and
// auditable afterwards — not left to the model's discretion in the moment.
//
// The default posture is restrictive. Everything irreversible or externally
// visible needs either an explicit standing grant or a human approval, and the
// failure mode of an unrecognised action is "ask", never "assume".

const { LedgerError, PRIORITIES, DEFAULT_SLA } = require('./ledger');

class ClientError extends LedgerError {}

function fail(message) {
  throw new ClientError(message);
}

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, field, { maxLength = 300 } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function stringList(value, field, { maxLength = 300 } = {}) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) fail(`${field} must be an array of strings`);
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`, { maxLength }).toLowerCase());
}

// Action types the assistant can take that touch the outside world or the
// client's money. Anything not on this list is unknown, and unknown means ask.
const ACTION_TYPES = Object.freeze([
  'send_email',
  'send_message',
  'schedule_meeting',
  'cancel_meeting',
  'spend',
  'commit_on_behalf',   // promising something in the principal's name
  'share_document',
  'sign',
  'delete_records',
  'contact_new_party',
]);

// Actions never delegated regardless of configuration. A client who wants the
// assistant signing contracts or filing on their behalf is asking for something
// this product does not do, and the answer needs to be structural rather than a
// paragraph in a contract nobody rereads.
const NEVER_DELEGATED = Object.freeze(['sign', 'delete_records']);

const DEFAULT_PROFILE = Object.freeze({
  spendApprovalCents: 0,          // 0 = every spend needs approval
  autoSendDomains: Object.freeze([]),
  neverAutoSend: Object.freeze([]),
  sensitiveTopics: Object.freeze(['legal', 'litigation', 'irs', 'tax notice', 'termination', 'investor', 'acquisition']),
  quietHours: Object.freeze({ start: 21, end: 7 }),
  workingDays: Object.freeze([1, 2, 3, 4, 5]),
});

/**
 * Build a validated client profile.
 *
 * Every grant here is a decision the client made in onboarding and can point
 * to later. Nothing widens on its own.
 */
function defineClient(input) {
  if (!isPlainObject(input)) fail('client profile must be an object');

  const profile = {
    clientId: requireString(input.clientId, 'clientId', { maxLength: 80 }),
    principal: requireString(input.principal, 'principal', { maxLength: 200 }),
    timezone: requireString(input.timezone ?? 'America/New_York', 'timezone', { maxLength: 80 }),

    // Legal entities whose records are kept apart. Mixing a personal charge
    // into a business entity's file is the single most common way an otherwise
    // clean set of books becomes a problem, so entities are declared up front.
    entities: (() => {
      const entities = Array.isArray(input.entities) ? input.entities : [];
      if (entities.length === 0) fail('at least one entity must be declared');
      return entities.map((entity, index) => {
        if (!isPlainObject(entity)) fail(`entity ${index} must be an object`);
        return {
          code: requireString(entity.code, `entity ${index} code`, { maxLength: 24 }).toUpperCase(),
          name: requireString(entity.name, `entity ${index} name`),
          kind: requireString(entity.kind ?? 'business', `entity ${index} kind`, { maxLength: 40 }),
        };
      });
    })(),

    // Authority
    spendApprovalCents: Number.isInteger(input.spendApprovalCents)
      ? input.spendApprovalCents
      : DEFAULT_PROFILE.spendApprovalCents,
    autoSendDomains: stringList(input.autoSendDomains, 'autoSendDomains'),
    neverAutoSend: stringList(input.neverAutoSend, 'neverAutoSend'),
    sensitiveTopics: input.sensitiveTopics
      ? stringList(input.sensitiveTopics, 'sensitiveTopics')
      : [...DEFAULT_PROFILE.sensitiveTopics],

    // Voice. Drafting in the principal's register is most of what makes
    // delegated correspondence usable without a rewrite.
    voice: {
      register: requireString(input.voice?.register ?? 'direct, warm, brief', 'voice.register'),
      signOff: requireString(input.voice?.signOff ?? 'Thanks,', 'voice.signOff', { maxLength: 80 }),
      avoid: stringList(input.voice?.avoid, 'voice.avoid', { maxLength: 120 }),
    },

    // Cadence
    quietHours: {
      start: Number.isInteger(input.quietHours?.start) ? input.quietHours.start : DEFAULT_PROFILE.quietHours.start,
      end: Number.isInteger(input.quietHours?.end) ? input.quietHours.end : DEFAULT_PROFILE.quietHours.end,
    },
    workingDays: Array.isArray(input.workingDays) ? input.workingDays.map(Number) : [...DEFAULT_PROFILE.workingDays],

    slaOverrides: (() => {
      if (!input.slaOverrides) return null;
      if (!isPlainObject(input.slaOverrides)) fail('slaOverrides must be an object');
      for (const key of Object.keys(input.slaOverrides)) {
        if (!PRIORITIES.includes(key)) fail(`slaOverrides has unknown priority ${key}`);
      }
      return input.slaOverrides;
    })(),

    connectedSystems: stringList(input.connectedSystems, 'connectedSystems', { maxLength: 80 }),
  };

  for (const hour of [profile.quietHours.start, profile.quietHours.end]) {
    if (hour < 0 || hour > 23) fail('quietHours must be hours 0–23');
  }
  const codes = new Set(profile.entities.map(entity => entity.code));
  if (codes.size !== profile.entities.length) fail('entity codes must be unique');

  return profile;
}

function matchesAnyDomain(address, domains) {
  const at = address.lastIndexOf('@');
  if (at < 0) return false;
  const domain = address.slice(at + 1).toLowerCase();
  return domains.some(candidate => domain === candidate || domain.endsWith(`.${candidate}`));
}

function mentionsSensitiveTopic(text, topics) {
  if (!text) return null;
  const haystack = text.toLowerCase();
  return topics.find(topic => haystack.includes(topic)) ?? null;
}

/**
 * Decide whether an action may be taken outright, must be drafted for approval,
 * or must be refused.
 *
 * Called before anything leaves the building. The returned `reason` is written
 * to be shown to the principal verbatim, because "I did not send this, here is
 * why" is itself part of the service.
 */
function authorityCheck(action, profile) {
  if (!isPlainObject(action)) fail('action must be an object');
  const type = action.type;

  const refuse = (reason) => ({ decision: 'refuse', reason, requiredApprover: null });
  const escalate = (reason) => ({ decision: 'draft-for-approval', reason, requiredApprover: profile.principal });
  const proceed = (reason) => ({ decision: 'proceed', reason, requiredApprover: null });

  if (!ACTION_TYPES.includes(type)) {
    // Unknown action, unknown blast radius. Ask.
    return escalate(`"${type}" is not an action type with a standing rule, so it goes to you rather than out the door.`);
  }

  if (NEVER_DELEGATED.includes(type)) {
    return refuse(
      `Signing and record deletion are never delegated to the assistant under any configuration. `
      + `Prepared for you to execute instead.`,
    );
  }

  const recipient = typeof action.recipient === 'string' ? action.recipient.toLowerCase() : null;
  const subject = [action.subject, action.body, action.summary].filter(Boolean).join(' ');

  if (recipient && profile.neverAutoSend.some(entry => recipient.includes(entry))) {
    return escalate(`${action.recipient} is on your review-first list; drafted for your approval instead of sent.`);
  }

  const sensitive = mentionsSensitiveTopic(subject, profile.sensitiveTopics);
  if (sensitive) {
    return escalate(`This touches "${sensitive}", which is on your sensitive-topics list. Drafted, not sent.`);
  }

  if (type === 'spend' || type === 'commit_on_behalf') {
    const amount = Number.isInteger(action.amountCents) ? action.amountCents : null;
    if (amount === null) {
      return escalate('No amount was attached to this commitment, so it cannot be checked against your approval limit.');
    }
    if (Math.abs(amount) > profile.spendApprovalCents) {
      const limit = (profile.spendApprovalCents / 100).toFixed(2);
      return escalate(`Above your standing limit of $${limit}; needs your yes before it goes ahead.`);
    }
    return proceed(`Within your standing spend authority of $${(profile.spendApprovalCents / 100).toFixed(2)}.`);
  }

  if (type === 'contact_new_party') {
    return escalate('First contact with a new counterparty is introduced by you, not by me. Draft ready.');
  }

  if (type === 'send_email' || type === 'send_message' || type === 'share_document') {
    if (!recipient) return escalate('No recipient resolved; not sending into the dark.');
    if (action.external === false) return proceed('Internal recipient within your own organisation.');
    if (matchesAnyDomain(recipient, profile.autoSendDomains)) {
      return proceed(`${action.recipient} is on your auto-send allowlist.`);
    }
    return escalate(`${action.recipient} is outside your auto-send allowlist; drafted for a quick yes.`);
  }

  if (type === 'schedule_meeting' || type === 'cancel_meeting') {
    if (action.irreversible === true || action.attendeesNotified === true) {
      return escalate('This would notify attendees immediately and cannot be quietly undone; confirming first.');
    }
    return proceed('Calendar changes inside your stated working pattern are mine to make.');
  }

  return escalate('No standing rule covers this; bringing it to you.');
}

/**
 * The onboarding gate.
 *
 * Returns what still has to be answered before the assistant can operate
 * without constant interruption. Running this at kickoff is how a client
 * engagement starts productive instead of spending week one on clarifications.
 */
function readinessReport(profile) {
  const missing = [];

  if (profile.spendApprovalCents === 0) {
    missing.push({
      field: 'spendApprovalCents',
      impact: 'Every purchase, however small, will come back to you for approval.',
      ask: 'What dollar amount can I spend without asking?',
    });
  }
  if (profile.autoSendDomains.length === 0) {
    missing.push({
      field: 'autoSendDomains',
      impact: 'Every outbound email waits on your approval, including routine internal replies.',
      ask: 'Which domains can I correspond with directly?',
    });
  }
  if (profile.connectedSystems.length === 0) {
    missing.push({
      field: 'connectedSystems',
      impact: 'Without inbox, calendar and file access I can only draft, not execute.',
      ask: 'Which systems am I being given access to, and at what permission level?',
    });
  }
  if (profile.entities.length === 1 && profile.entities[0].kind === 'business') {
    missing.push({
      field: 'entities',
      impact: 'Personal spending will land in the business file and have to be unpicked at year end.',
      ask: 'Should I set up a separate personal entity for record-keeping?',
    });
  }
  if (!profile.slaOverrides) {
    missing.push({
      field: 'slaOverrides',
      impact: `Follow-up runs on the defaults (${DEFAULT_SLA.high.acknowledgeHours}h acknowledgement on high priority).`,
      ask: 'Are the default response times right for your world, or should they be tighter?',
    });
  }

  return {
    clientId: profile.clientId,
    // Blunt rather than flattering: a half-configured assistant that reports
    // itself ready is how the first week goes badly.
    operational: missing.length === 0,
    readiness: Math.round(100 * (1 - missing.length / 5)),
    missing,
  };
}

module.exports = {
  ClientError,
  ACTION_TYPES,
  NEVER_DELEGATED,
  DEFAULT_PROFILE,
  defineClient,
  authorityCheck,
  readinessReport,
};
