'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { defineClient, authorityCheck, readinessReport, ACTION_TYPES, ClientError } = require('../src/client');

function profile(overrides = {}) {
  return defineClient({
    clientId: 'acme',
    principal: 'Dana Reyes',
    entities: [{ code: 'MBX', name: 'Music Box Inc', kind: 'business' }, { code: 'PERS', name: 'Personal', kind: 'personal' }],
    spendApprovalCents: 25000,
    autoSendDomains: ['musicbox.com', 'sweetwater.com'],
    neverAutoSend: ['counsel@', 'irs.gov'],
    connectedSystems: ['gmail', 'gcal'],
    ...overrides,
  });
}

test('a client must declare at least one entity', () => {
  assert.throws(() => defineClient({ clientId: 'a', principal: 'B', entities: [] }), /at least one entity/);
});

test('duplicate entity codes are refused', () => {
  assert.throws(() => defineClient({
    clientId: 'a', principal: 'B',
    entities: [{ code: 'X', name: 'One' }, { code: 'x', name: 'Two' }],
  }), /entity codes must be unique/);
});

test('an unknown SLA priority is refused', () => {
  assert.throws(() => profile({ slaOverrides: { urgent: {} } }), /unknown priority/);
});

test('quiet hours must be real hours', () => {
  assert.throws(() => profile({ quietHours: { start: 25, end: 7 } }), /hours 0–23/);
});

// The default posture is the product's core promise: nothing goes out on an
// assumption.
test('an unrecognised action asks rather than assumes', () => {
  const verdict = authorityCheck({ type: 'wire_funds', amountCents: 100 }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /not an action type with a standing rule/);
});

test('signing and record deletion are refused under every configuration', () => {
  const permissive = profile({ spendApprovalCents: 100000000, autoSendDomains: ['*'] });
  for (const type of ['sign', 'delete_records']) {
    const verdict = authorityCheck({ type }, permissive);
    assert.equal(verdict.decision, 'refuse', `${type} was delegated`);
  }
});

test('spending within the standing limit proceeds', () => {
  const verdict = authorityCheck({ type: 'spend', amountCents: 19900 }, profile());
  assert.equal(verdict.decision, 'proceed');
});

test('spending over the limit needs a yes', () => {
  const verdict = authorityCheck({ type: 'spend', amountCents: 25001 }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /\$250\.00/);
});

test('the limit is exact at the boundary', () => {
  assert.equal(authorityCheck({ type: 'spend', amountCents: 25000 }, profile()).decision, 'proceed');
});

test('a refund is checked on magnitude, not sign', () => {
  assert.equal(authorityCheck({ type: 'spend', amountCents: -99900 }, profile()).decision, 'draft-for-approval');
});

test('a spend with no amount cannot be waved through', () => {
  const verdict = authorityCheck({ type: 'spend' }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /No amount was attached/);
});

test('the default profile requires approval for every purchase', () => {
  const cautious = defineClient({ clientId: 'a', principal: 'B', entities: [{ code: 'X', name: 'One' }] });
  assert.equal(authorityCheck({ type: 'spend', amountCents: 1 }, cautious).decision, 'draft-for-approval');
});

test('allowlisted domains send without interruption', () => {
  assert.equal(authorityCheck({ type: 'send_email', recipient: 'rep@sweetwater.com' }, profile()).decision, 'proceed');
});

test('subdomains of an allowlisted domain are covered', () => {
  assert.equal(authorityCheck({ type: 'send_email', recipient: 'a@mail.musicbox.com' }, profile()).decision, 'proceed');
});

test('a lookalike domain is not treated as allowlisted', () => {
  const verdict = authorityCheck({ type: 'send_email', recipient: 'a@notmusicbox.com' }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
});

test('everyone else gets drafted', () => {
  assert.equal(authorityCheck({ type: 'send_email', recipient: 'partner@unknown.io' }, profile()).decision, 'draft-for-approval');
});

test('the review-first list overrides the allowlist', () => {
  const verdict = authorityCheck({ type: 'send_email', recipient: 'counsel@musicbox.com' }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /review-first list/);
});

test('a sensitive topic stops an otherwise allowlisted send', () => {
  const verdict = authorityCheck(
    { type: 'send_email', recipient: 'cfo@musicbox.com', subject: 'IRS notice received' },
    profile(),
  );
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /irs/);
});

test('sensitive topics are matched in the body, not only the subject', () => {
  const verdict = authorityCheck(
    { type: 'send_email', recipient: 'cfo@musicbox.com', subject: 'Quick note', body: 'about the pending litigation' },
    profile(),
  );
  assert.equal(verdict.decision, 'draft-for-approval');
});

test('sending with no resolved recipient is refused outright', () => {
  const verdict = authorityCheck({ type: 'send_email' }, profile());
  assert.equal(verdict.decision, 'draft-for-approval');
  assert.match(verdict.reason, /into the dark/);
});

test('first contact with a new counterparty is always introduced by the principal', () => {
  assert.equal(authorityCheck({ type: 'contact_new_party', recipient: 'a@musicbox.com' }, profile()).decision, 'draft-for-approval');
});

test('routine calendar work proceeds but attendee-notifying changes do not', () => {
  assert.equal(authorityCheck({ type: 'schedule_meeting' }, profile()).decision, 'proceed');
  assert.equal(authorityCheck({ type: 'cancel_meeting', attendeesNotified: true }, profile()).decision, 'draft-for-approval');
});

test('every action type resolves to a decision, and every decision explains itself', () => {
  for (const type of ACTION_TYPES) {
    const verdict = authorityCheck({ type, recipient: 'x@unknown.io', amountCents: 1 }, profile());
    assert.ok(['proceed', 'draft-for-approval', 'refuse'].includes(verdict.decision), `${type} produced ${verdict.decision}`);
    assert.ok(verdict.reason.length > 15, `${type} gave no usable reason`);
  }
});

test('an escalation names who has to approve', () => {
  const verdict = authorityCheck({ type: 'spend', amountCents: 999999 }, profile());
  assert.equal(verdict.requiredApprover, 'Dana Reyes');
});

test('readiness reports what is still unanswered, bluntly', () => {
  const report = readinessReport(defineClient({ clientId: 'a', principal: 'B', entities: [{ code: 'X', name: 'One' }] }));
  assert.equal(report.operational, false);
  const fields = report.missing.map(gap => gap.field);
  assert.ok(fields.includes('spendApprovalCents'));
  assert.ok(fields.includes('autoSendDomains'));
  assert.ok(fields.includes('connectedSystems'));
  for (const gap of report.missing) {
    assert.ok(gap.impact && gap.ask, `${gap.field} has no stated impact or question`);
  }
});

test('a fully configured client reports operational', () => {
  const report = readinessReport(profile({ slaOverrides: { high: { acknowledgeHours: 2 } } }));
  assert.equal(report.operational, true);
  assert.equal(report.readiness, 100);
});
