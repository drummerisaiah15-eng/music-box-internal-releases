'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { reconcile, categorySummary, findGaps, cpaPacket, vendorSimilarity } = require('../src/finance');

function doc(overrides = {}) {
  return {
    id: 'd1',
    date: '2026-03-14',
    entity: 'MBX',
    docType: 'RECEIPT',
    counterparty: 'Sweetwater Sound',
    amountCents: 128499,
    category: 'equipment',
    extension: 'pdf',
    ...overrides,
  };
}

function line(overrides = {}) {
  return { id: 'l1', date: '2026-03-16', description: 'SQ *SWEETWATER SOUND 8005551212', amount: '-1284.99', ...overrides };
}

test('processor noise does not stop a vendor matching its receipt', () => {
  assert.ok(vendorSimilarity('SQ *SWEETWATER SOUND 8005551212', 'Sweetwater-Sound') >= 0.5);
  assert.ok(vendorSimilarity('TST* BLUE BOTTLE 0092', 'Blue-Bottle') >= 0.5);
});

test('unrelated vendors do not match', () => {
  assert.equal(vendorSimilarity('DELTA AIR 006219', 'Sweetwater-Sound'), 0);
});

test('a charge and its receipt reconcile across a posting delay', () => {
  const result = reconcile([line()], [doc()]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].driftDays, 2);
  assert.equal(result.matched[0].confidence, 'high');
  assert.equal(result.unreceipted.length, 0);
});

test('sign conventions between exports do not break matching', () => {
  const result = reconcile([line({ amount: '1284.99' })], [doc()]);
  assert.equal(result.matched.length, 1);
});

test('amounts must agree to the cent', () => {
  // One cent out is a different transaction, not a rounding artefact. Matching
  // it would file a receipt against a charge it does not substantiate.
  const result = reconcile([line({ amount: '-1285.00' })], [doc()]);
  assert.equal(result.matched.length, 0);
  assert.equal(result.unreceipted.length, 1);
});

test('a charge outside the posting window is not matched', () => {
  const result = reconcile([line({ date: '2026-04-20' })], [doc()]);
  assert.equal(result.matched.length, 0);
});

test('a right-amount wrong-name match is surfaced rather than trusted', () => {
  const result = reconcile([line({ description: 'UNKNOWN MERCHANT 4471' })], [doc()]);
  assert.equal(result.matched.length, 1);
  assert.equal(result.matched[0].confidence, 'needs-eyes');
});

test('one receipt cannot substantiate two identical charges', () => {
  const result = reconcile(
    [line({ id: 'l1' }), line({ id: 'l2', date: '2026-03-15' })],
    [doc()],
  );
  assert.equal(result.matched.length, 1);
  assert.equal(result.unreceipted.length, 1, 'the second charge is still unsubstantiated');
});

test('the closer of two candidate charges wins', () => {
  const result = reconcile(
    [line({ id: 'far', date: '2026-03-18' }), line({ id: 'near', date: '2026-03-14' })],
    [doc()],
  );
  assert.equal(result.matched[0].lineId, 'near');
});

test('reconciliation is deterministic across runs', () => {
  const lines = [line({ id: 'a' }), line({ id: 'b', date: '2026-03-15' }), line({ id: 'c', description: 'DELTA AIR', amount: '-612.40' })];
  const docs = [doc({ id: 'x' }), doc({ id: 'y', date: '2026-03-13' })];
  const first = JSON.stringify(reconcile(lines, docs));
  assert.equal(first, JSON.stringify(reconcile(lines, docs)));
});

test('dollar coverage is reported alongside item coverage', () => {
  const result = reconcile(
    [line(), line({ id: 'l2', description: 'DELTA AIR 0062199', amount: '-612.40' })],
    [doc()],
  );
  assert.equal(result.coverage.byCount, 0.5);
  assert.ok(result.coverage.byDollars > 0.6, 'one small gap should not read like half the money is missing');
  assert.equal(result.coverage.unreceiptedCents, 61240);
});

test('a receipt with no matching charge is reported, not discarded', () => {
  const result = reconcile([], [doc()]);
  assert.equal(result.unmatchedDocuments.length, 1);
  assert.match(result.unmatchedDocuments[0].exposure, /paid another way, duplicated, or dated wrong/);
});

test('personal spending is tracked but kept out of the business total', () => {
  const summary = categorySummary([
    doc({ id: 'a', category: 'equipment', amountCents: 100000 }),
    doc({ id: 'b', category: 'personal', amountCents: 50000 }),
    doc({ id: 'c', category: 'owner_draw', amountCents: 25000 }),
  ]);
  assert.equal(summary.businessTotalCents, 100000);
  assert.equal(summary.excludedTotalCents, 75000);
  assert.equal(summary.rows.length, 3, 'excluded items stay visible so the exclusion is auditable');
});

test('every category carries a Schedule C pointer for the CPA', () => {
  for (const row of categorySummary([doc({ category: 'meals' }), doc({ id: 'z', category: 'travel' })]).rows) {
    assert.ok(row.scheduleC && row.scheduleC.length > 0);
  }
});

test('meals and travel without a business purpose are blocking gaps', () => {
  const gaps = findGaps([doc({ category: 'meals', amountCents: 4210 })]);
  assert.ok(gaps.some(gap => gap.severity === 'blocking' && /business purpose/.test(gap.issue)));
  assert.ok(gaps.some(gap => /attendees/.test(gap.issue)));
});

// A gap the reader cannot trace back to a specific piece of paper is not
// actionable: "Meals on 2026-03-02" names a category, not a receipt.
test('every gap identifies the document by vendor, date and amount', () => {
  const gaps = findGaps([
    doc({ id: 'a', counterparty: 'Blue Bottle', date: '2026-03-02', amountCents: 4210, category: 'meals' }),
    doc({ id: 'b', counterparty: 'Delta Air', date: '2026-03-09', amountCents: 61240, category: 'travel' }),
    doc({ id: 'c', counterparty: 'Amazon', date: '2026-03-11', amountCents: 28400, category: 'uncategorised' }),
  ]);
  for (const gap of gaps) {
    assert.match(gap.issue, /\d{4}-\d{2}-\d{2}/, `${gap.documentId} gap has no date`);
    assert.match(gap.issue, /\$[\d,]+\.\d{2}/, `${gap.documentId} gap has no amount`);
  }
  assert.ok(gaps.some(gap => /Blue Bottle, 2026-03-02, \$42\.10/.test(gap.issue)));
  assert.ok(gaps.some(gap => /Amazon, 2026-03-11, \$284\.00 has no category/.test(gap.issue)));
});

test('a meal with purpose and attendees raises no blocking gap', () => {
  const gaps = findGaps([doc({ category: 'meals', businessPurpose: 'Vendor negotiation', attendees: ['Marcus H.'] })]);
  assert.equal(gaps.filter(gap => gap.severity === 'blocking').length, 0);
});

test('gaps are ordered so the biggest exposure is worked first', () => {
  const gaps = findGaps([
    doc({ id: 'small', category: 'uncategorised', amountCents: 500 }),
    doc({ id: 'large', category: 'uncategorised', amountCents: 500000 }),
  ]);
  assert.equal(gaps[0].documentId, 'large');
});

test('an unreadable amount is a blocking gap, not a zero', () => {
  const gaps = findGaps([doc({ amountCents: null })]);
  assert.ok(gaps.some(gap => gap.severity === 'blocking' && /no amount recorded/.test(gap.issue)));
});

test('the CPA packet states its own scope limit', () => {
  const packet = cpaPacket({ taxYear: 2026, entity: 'MBX', documents: [doc()], statementLines: [line()], preparedOn: '2026-09-06' });
  assert.match(packet.scopeNote, /not tax determinations/);
});

test('the packet refuses to call itself ready while questions are open', () => {
  const packet = cpaPacket({
    taxYear: 2026,
    entity: 'MBX',
    documents: [doc()],
    statementLines: [line(), line({ id: 'l2', description: 'DELTA AIR', amount: '-612.40' })],
    preparedOn: '2026-09-06',
  });
  assert.equal(packet.readyToSend, false);
  assert.ok(packet.openQuestions.length > 0);
  assert.match(packet.openQuestions.join(' '), /\$612\.40/);
});

test('a clean file reports itself ready', () => {
  const packet = cpaPacket({ taxYear: 2026, entity: 'MBX', documents: [doc()], statementLines: [line()], preparedOn: '2026-09-06' });
  assert.equal(packet.readyToSend, true);
  assert.equal(packet.readiness, 100);
});

// Filtering on the year alone put a personal receipt into the business packet
// and inflated the business total with money that was never the business's.
test('the packet is scoped to one entity, not just one year', () => {
  const packet = cpaPacket({
    taxYear: 2026,
    entity: 'MBX',
    documents: [
      doc({ id: 'biz', entity: 'MBX', amountCents: 100000, category: 'equipment' }),
      doc({ id: 'personal', entity: 'PERS', amountCents: 50000, category: 'meals', businessPurpose: 'x', attendees: ['y'] }),
    ],
    statementLines: [],
    preparedOn: '2026-09-06',
  });
  assert.equal(packet.documentCount, 1);
  assert.equal(packet.totals.businessTotalCents, 100000, 'the personal receipt must not reach the business total');
  assert.equal(packet.excludedOtherEntity.documents, 1);
});

test('statement lines are scoped by entity when they declare one', () => {
  const packet = cpaPacket({
    taxYear: 2026,
    entity: 'MBX',
    documents: [],
    statementLines: [
      { id: 'ours', date: '2026-03-14', description: 'A', amount: '-10.00', entity: 'MBX' },
      { id: 'theirs', date: '2026-03-14', description: 'B', amount: '-99.00', entity: 'PERS' },
    ],
    preparedOn: '2026-09-06',
  });
  assert.equal(packet.statementLineCount, 1);
  assert.equal(packet.excludedOtherEntity.statementLines, 1);
});

// Dropping an unattributed account would hide real spending; counting it
// silently would misattribute it. It is counted and asked about.
test('an unattributed account is asked about when the client has several entities', () => {
  const args = {
    taxYear: 2026,
    entity: 'MBX',
    documents: [],
    statementLines: [{ id: 'l', date: '2026-03-14', description: 'A', amount: '-10.00', account: 'amex-1005' }],
    preparedOn: '2026-09-06',
  };
  const ambiguous = cpaPacket({ ...args, knownEntities: ['MBX', 'PERS'] });
  assert.equal(ambiguous.statementLineCount, 1, 'still counted, not dropped');
  assert.deepEqual(ambiguous.unattributedAccounts, ['amex-1005']);
  assert.match(ambiguous.openQuestions.join(' '), /confirm whose books it belongs to/);
  assert.equal(ambiguous.readyToSend, false);

  // One set of books means there is no other answer, so no question.
  const unambiguous = cpaPacket({ ...args, knownEntities: ['MBX'] });
  assert.deepEqual(unambiguous.unattributedAccounts, []);
});

test('documents from another tax year are excluded from the packet', () => {
  const packet = cpaPacket({
    taxYear: 2026,
    entity: 'MBX',
    documents: [doc(), doc({ id: 'old', date: '2025-03-14' })],
    statementLines: [line()],
    preparedOn: '2026-09-06',
  });
  assert.equal(packet.documentCount, 1);
});

test('an empty year produces a packet rather than an error', () => {
  const packet = cpaPacket({ taxYear: 2026, entity: 'MBX', documents: [], statementLines: [], preparedOn: '2026-09-06' });
  assert.equal(packet.documentCount, 0);
  assert.equal(packet.totals.businessTotalCents, 0);
});

test('an unknown category is refused rather than silently bucketed', () => {
  assert.throws(() => findGaps([doc({ category: 'vibes' })]), /unknown category/);
});
