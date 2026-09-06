'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { verifyClaim, decisionMatrix } = require('../src/research');

const ASOF = { asOf: '2026-09-06' };

function source(overrides = {}) {
  return { kind: 'reputable', publisher: 'The Times', retrievedOn: '2026-09-01', ...overrides };
}

test('a primary source settles a claim', () => {
  const result = verifyClaim({
    claim: 'The lease ends 2027-06-30',
    sources: [source({ kind: 'primary', publisher: 'Executed lease, p.4' })],
  }, ASOF);
  assert.equal(result.confidence, 'verified');
  assert.equal(result.isSolid, true);
  assert.equal(result.toSettle, null);
});

test('vendor marketing alone never counts as verified', () => {
  const result = verifyClaim({
    claim: 'Vendor A is SOC 2 Type II certified',
    sources: [source({ kind: 'vendor', publisher: 'Vendor A website' })],
  }, ASOF);
  assert.equal(result.confidence, 'unverified');
  assert.equal(result.isSolid, false);
  assert.match(result.toSettle, /lead, not a fact/);
});

test('a single reputable source is probable, not verified', () => {
  const result = verifyClaim({ claim: 'x', sources: [source()] }, ASOF);
  assert.equal(result.confidence, 'probable');
  assert.match(result.toSettle, /second independent source/);
});

test('two independent reputable sources verify a claim', () => {
  const result = verifyClaim({
    claim: 'x',
    sources: [source({ publisher: 'The Times' }), source({ publisher: 'The Journal' })],
  }, ASOF);
  assert.equal(result.confidence, 'verified');
});

// The core "signal from noise" test: syndication is not corroboration.
test('outlets reprinting one origin count as a single source', () => {
  const result = verifyClaim({
    claim: 'x',
    sources: [
      source({ publisher: 'Outlet A', origin: 'Reuters wire' }),
      source({ publisher: 'Outlet B', origin: 'Reuters wire' }),
      source({ publisher: 'Outlet C', origin: 'Reuters wire' }),
    ],
  }, ASOF);
  assert.equal(result.independentOrigins, 1);
  assert.equal(result.confidence, 'probable', 'three reprints of one wire story is one source');
});

test('a credible contradiction outranks any amount of agreement', () => {
  const result = verifyClaim({
    claim: 'The filing deadline is March 15',
    sources: [
      source({ publisher: 'Blog A' }),
      source({ publisher: 'Blog B' }),
      source({ kind: 'official', publisher: 'IRS instructions', supports: false }),
    ],
  }, ASOF);
  assert.equal(result.confidence, 'disputed');
  assert.equal(result.contradictions.length, 1);
  assert.match(result.toSettle, /primary document/);
});

test('stale support is reported as stale rather than accepted', () => {
  const result = verifyClaim({
    claim: 'The plan costs $40/seat',
    kind: 'pricing',
    sources: [source({ kind: 'official', publisher: 'Vendor pricing page', retrievedOn: '2025-01-01' })],
  }, ASOF);
  assert.equal(result.confidence, 'stale');
  assert.match(result.toSettle, /Re-check/);
});

test('freshness windows differ by claim type', () => {
  const old = { publisher: 'Statute text', kind: 'primary', retrievedOn: '2026-01-01' };
  assert.equal(verifyClaim({ claim: 'x', kind: 'regulatory', sources: [old] }, ASOF).confidence, 'verified');
  assert.equal(verifyClaim({ claim: 'x', kind: 'pricing', sources: [old] }, ASOF).confidence, 'stale');
});

test('a claim with no support says so plainly', () => {
  const result = verifyClaim({ claim: 'x', sources: [] }, ASOF);
  assert.equal(result.confidence, 'unsupported');
  assert.equal(result.isSolid, false);
});

test('every unsettled claim comes with what would settle it', () => {
  for (const kind of ['vendor', 'ugc', 'trade']) {
    const result = verifyClaim({ claim: 'x', sources: [source({ kind })] }, ASOF);
    if (!result.isSolid) assert.ok(result.toSettle, `${kind} gave no route to settle`);
  }
});

test('citations survive intact for the reader to check', () => {
  const result = verifyClaim({
    claim: 'x',
    sources: [source({ url: 'https://example.com/a' }), source({ publisher: 'Other', supports: false })],
  }, ASOF);
  assert.equal(result.citations.length, 2);
  assert.equal(result.citations[0].stance, 'supports');
  assert.equal(result.citations[1].stance, 'contradicts');
});

test('an unknown source kind is refused', () => {
  assert.throws(() => verifyClaim({ claim: 'x', sources: [source({ kind: 'hearsay' })] }, ASOF), /unknown kind/);
});

const CRITERIA = [
  { id: 'cost', label: 'Cost', weight: 3, lowerIsBetter: true },
  { id: 'support', label: 'Support quality', weight: 4 },
  { id: 'integration', label: 'Integrations', weight: 2 },
];

test('cost is inverted so lower really is better', () => {
  const result = decisionMatrix({
    question: 'q',
    criteria: [{ id: 'cost', label: 'Cost', weight: 1, lowerIsBetter: true }],
    options: [{ id: 'Cheap', scores: { cost: 1 } }, { id: 'Expensive', scores: { cost: 9 } }],
  });
  assert.equal(result.winner, 'Cheap');
});

test('a clear winner is reported as robust', () => {
  const result = decisionMatrix({
    question: 'Which payroll provider?',
    criteria: CRITERIA,
    options: [
      { id: 'Strong', scores: { cost: 2, support: 9, integration: 9 } },
      { id: 'Weak', scores: { cost: 8, support: 3, integration: 2 } },
    ],
  });
  assert.equal(result.winner, 'Strong');
  assert.equal(result.robust, true);
  assert.equal(result.confidence, 'high');
  assert.match(result.recommendation, /Go with Strong/);
});

// The differentiator: a matrix always produces a winner, so the useful output
// is whether that winner survives someone disagreeing with the weights.
test('a weight-sensitive winner is flagged instead of asserted', () => {
  const result = decisionMatrix({
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 5, support: 9, integration: 5 } },
      { id: 'B', scores: { cost: 5, support: 7, integration: 8 } },
    ],
  });
  assert.equal(result.robust, false);
  assert.ok(result.flips.length > 0);
  assert.match(result.recommendation, /not weight-proof/);
  assert.equal(result.confidence, 'moderate');
});

test('the flip report names the criterion that changes the answer', () => {
  const result = decisionMatrix({
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 5, support: 9, integration: 5 } },
      { id: 'B', scores: { cost: 5, support: 7, integration: 8 } },
    ],
  });
  assert.ok(result.flippingCriteria.includes('integration'), 'integration flips the winner');
  assert.ok(result.flippingCriteria.includes('support'), 'so does support, and both must be reported');
  for (const flip of result.flips) {
    assert.match(flip.note, /wins instead/, 'each flip states the consequence in words');
    assert.ok([0.5, 2].includes(flip.multiplier));
  }
  // Quoting only the first flip would understate how close the call is.
  assert.match(result.recommendation, /2 of the 3 criteria flip the winner/);
});

test('a recommendation resting on an unverified claim says so', () => {
  const claim = verifyClaim({
    claim: 'Vendor A includes SOC 2',
    sources: [{ kind: 'vendor', publisher: 'Vendor A site', retrievedOn: '2026-09-01' }],
  }, ASOF);
  const result = decisionMatrix({
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 2, support: 9, integration: 9 }, restsOn: ['Vendor A includes SOC 2'] },
      { id: 'B', scores: { cost: 8, support: 3, integration: 2 } },
    ],
    claims: [claim],
  });
  assert.equal(result.shakyInputs.length, 1);
  assert.equal(result.confidence, 'moderate');
  assert.match(result.recommendation, /unconfirmed input/);
});

test('unverified and weight-sensitive together drop confidence to low', () => {
  const claim = verifyClaim({ claim: 'c', sources: [] }, ASOF);
  const result = decisionMatrix({
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 5, support: 9, integration: 5 }, restsOn: ['c'] },
      { id: 'B', scores: { cost: 5, support: 7, integration: 8 } },
    ],
    claims: [claim],
  });
  assert.equal(result.confidence, 'low');
  assert.match(result.recommendation, /leading candidate, not a decision/);
});

test('a verified dependency does not dent confidence', () => {
  const claim = verifyClaim({ claim: 'c', sources: [{ kind: 'primary', publisher: 'Signed quote', retrievedOn: '2026-09-01' }] }, ASOF);
  const result = decisionMatrix({
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 2, support: 9, integration: 9 }, restsOn: ['c'] },
      { id: 'B', scores: { cost: 8, support: 3, integration: 2 } },
    ],
    claims: [claim],
  });
  assert.equal(result.confidence, 'high');
});

test('a missing score is refused rather than treated as zero', () => {
  assert.throws(
    () => decisionMatrix({
      question: 'q',
      criteria: CRITERIA,
      options: [{ id: 'A', scores: { cost: 5, support: 8 } }, { id: 'B', scores: { cost: 4, support: 7, integration: 9 } }],
    }),
    /missing a score for "integration"/,
    'a blank cell scored as zero silently loses the option the comparison exists to test',
  );
});

test('one option is not a decision', () => {
  assert.throws(
    () => decisionMatrix({ question: 'q', criteria: CRITERIA, options: [{ id: 'A', scores: { cost: 1, support: 1, integration: 1 } }] }),
    /at least two options/,
  );
});

test('out-of-range scores and bad weights are refused', () => {
  assert.throws(() => decisionMatrix({
    question: 'q', criteria: CRITERIA,
    options: [{ id: 'A', scores: { cost: 50, support: 1, integration: 1 } }, { id: 'B', scores: { cost: 1, support: 1, integration: 1 } }],
  }), /must be 0–10/);
  assert.throws(() => decisionMatrix({
    question: 'q', criteria: [{ id: 'c', weight: 0 }],
    options: [{ id: 'A', scores: { c: 1 } }, { id: 'B', scores: { c: 2 } }],
  }), /positive number/);
});

test('ranking is stable and complete', () => {
  const input = {
    question: 'q',
    criteria: CRITERIA,
    options: [
      { id: 'A', scores: { cost: 5, support: 8, integration: 3 } },
      { id: 'B', scores: { cost: 4, support: 7, integration: 9 } },
      { id: 'C', scores: { cost: 5, support: 5, integration: 5 } },
    ],
  };
  const first = decisionMatrix(input);
  assert.deepEqual(first.ranking.map(r => r.id), decisionMatrix(input).ranking.map(r => r.id));
  assert.deepEqual(first.ranking.map(r => r.rank), [1, 2, 3]);
});
