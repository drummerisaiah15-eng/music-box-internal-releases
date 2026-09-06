'use strict';

// Research and decision support.
//
// The brief the principal asked for is not a summary of what the internet says.
// It is a recommendation they can act on, with the parts that are actually
// established separated from the parts that are merely repeated, and with an
// honest statement of what would change the answer.
//
// Two ideas do the work here:
//
//   1. Independence, not volume. Three outlets running the same press release
//      are one source. `verifyClaim` counts distinct origins, not links.
//   2. Robustness, not scores. A weighted matrix always produces a winner; the
//      useful question is whether that winner survives someone disagreeing
//      with the weights. `decisionMatrix` answers that and says so out loud.

const { LedgerError } = require('./ledger');

class ResearchError extends LedgerError {}

function fail(message) {
  throw new ResearchError(message);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Lower tier number = closer to the thing itself. The ordering is what lets
// "separate signal from noise" be a procedure instead of an instinct.
const SOURCE_TIERS = Object.freeze({
  primary: { tier: 1, label: 'Primary — the document, contract, filing, or first-party data itself' },
  official: { tier: 2, label: 'Official — regulator, court, standards body, government' },
  reputable: { tier: 3, label: 'Reputable secondary — established outlet or peer-reviewed work' },
  trade: { tier: 4, label: 'Trade press or analyst note' },
  vendor: { tier: 5, label: 'Vendor marketing or sales collateral' },
  ugc: { tier: 6, label: 'Forum, review site, social, or anonymous' },
});

// How stale a claim is allowed to be before it needs re-checking. Pricing moves
// constantly; a statute does not.
const DEFAULT_FRESHNESS_DAYS = Object.freeze({
  pricing: 90,
  availability: 90,
  regulatory: 365,
  technical: 365,
  reputational: 180,
  general: 365,
});

function isPlainObject(value) {
  return Boolean(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function requireString(value, field, { maxLength = 2000 } = {}) {
  if (typeof value !== 'string' || !value.trim()) fail(`${field} must be a non-empty string`);
  const trimmed = value.trim();
  if (trimmed.length > maxLength) fail(`${field} must be at most ${maxLength} characters`);
  return trimmed;
}

function requireDate(value, field) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(`${field} must be a YYYY-MM-DD date`);
  }
  if (Number.isNaN(Date.parse(`${text}T00:00:00Z`))) fail(`${field} is not a real date`);
  return text;
}

/**
 * A source backing a claim.
 *
 * `origin` is the crucial field: it names who actually produced the
 * information. Two articles with different URLs and the same `origin` are one
 * source, and defaulting `origin` to the publisher means the common case is
 * handled without the researcher having to think about it.
 */
function normalizeSource(input, index) {
  if (!isPlainObject(input)) fail(`source ${index} must be an object`);
  const kind = input.kind ?? 'ugc';
  if (!Object.hasOwn(SOURCE_TIERS, kind)) {
    fail(`source ${index} has unknown kind ${kind}; expected one of ${Object.keys(SOURCE_TIERS).join(', ')}`);
  }
  const publisher = requireString(input.publisher, `source ${index} publisher`, { maxLength: 200 });
  return {
    kind,
    tier: SOURCE_TIERS[kind].tier,
    publisher,
    origin: input.origin ? requireString(input.origin, `source ${index} origin`, { maxLength: 200 }) : publisher,
    url: input.url ? requireString(input.url, `source ${index} url`, { maxLength: 1000 }) : null,
    retrievedOn: requireDate(input.retrievedOn, `source ${index} retrievedOn`),
    supports: input.supports === undefined ? true : Boolean(input.supports),
    excerpt: input.excerpt ? requireString(input.excerpt, `source ${index} excerpt`, { maxLength: 1000 }) : null,
  };
}

/**
 * Grade a single factual claim.
 *
 * Returns a confidence label, the reasoning behind it, and — when the claim
 * does not clear the bar — the specific thing that would settle it. "I could
 * not confirm this" is only useful when it comes with "here is what would."
 */
function verifyClaim(input, { asOf } = {}) {
  if (!isPlainObject(input)) fail('claim must be an object');
  const claim = requireString(input.claim, 'claim');
  const kind = input.kind ?? 'general';
  const today = requireDate(asOf ?? new Date().toISOString().slice(0, 10), 'asOf');
  const maxAgeDays = input.maxAgeDays ?? DEFAULT_FRESHNESS_DAYS[kind] ?? DEFAULT_FRESHNESS_DAYS.general;

  const sources = (input.sources ?? []).map(normalizeSource);

  const supporting = sources.filter(source => source.supports);
  const contradicting = sources.filter(source => !source.supports);

  const stale = supporting.filter(source =>
    (Date.parse(`${today}T00:00:00Z`) - Date.parse(`${source.retrievedOn}T00:00:00Z`)) / DAY_MS > maxAgeDays);
  const fresh = supporting.filter(source => !stale.includes(source));

  // Independence is counted over origins, so a syndicated wire story picked up
  // by six outlets contributes one, not six.
  const independentOrigins = new Set(fresh.map(source => source.origin));
  const bestTier = fresh.reduce((best, source) => Math.min(best, source.tier), Number.POSITIVE_INFINITY);
  const strongCount = fresh.filter(source => source.tier <= 3).length;

  let confidence;
  let rationale;
  let toSettle = null;

  if (supporting.length === 0) {
    confidence = 'unsupported';
    rationale = 'No supporting source was found.';
    toSettle = 'Find a primary or official source before this is repeated to anyone.';
  } else if (contradicting.length > 0
    && contradicting.some(source => source.tier <= Math.max(3, bestTier))) {
    // A credible contradiction outranks any amount of agreement. Surfacing the
    // conflict is the whole job; quietly picking the majority is not.
    confidence = 'disputed';
    rationale = `Sources conflict: ${contradicting.map(s => s.publisher).join(', ')} contradict `
      + `${fresh.map(s => s.publisher).join(', ') || 'the supporting material'}.`;
    toSettle = 'Go to the primary document, or put the discrepancy to the counterparty directly.';
  } else if (fresh.length === 0) {
    confidence = 'stale';
    rationale = `The only support is older than the ${maxAgeDays}-day window for ${kind} claims `
      + `(newest: ${supporting.map(s => s.retrievedOn).sort().reverse()[0]}).`;
    toSettle = 'Re-check the current figure at the source before relying on it.';
  } else if (bestTier <= 2) {
    confidence = 'verified';
    rationale = `Confirmed against ${SOURCE_TIERS[fresh.find(s => s.tier === bestTier).kind].label.toLowerCase()}.`;
  } else if (bestTier === 3 && independentOrigins.size >= 2) {
    confidence = 'verified';
    rationale = `Two or more independent reputable sources agree (${[...independentOrigins].join(', ')}).`;
  } else if (bestTier === 3) {
    confidence = 'probable';
    rationale = 'One reputable source, not independently corroborated.';
    toSettle = 'A second independent source, or the primary document, would settle it.';
  } else if (independentOrigins.size >= 2 && strongCount === 0 && bestTier <= 5) {
    confidence = 'probable';
    rationale = `Multiple lower-tier sources agree (${[...independentOrigins].join(', ')}) but none is authoritative.`;
    toSettle = 'Confirm with the vendor in writing or find an official source.';
  } else {
    confidence = 'unverified';
    rationale = `Only ${SOURCE_TIERS[fresh[0].kind].label.toLowerCase()} supports this.`;
    toSettle = 'Treat as a lead, not a fact, until a tier 1–3 source confirms it.';
  }

  return {
    claim,
    kind,
    confidence,
    // The flag the rest of the system reads. Everything below `verified` is
    // labelled wherever it appears, including inside a recommendation.
    isSolid: confidence === 'verified',
    rationale,
    toSettle,
    sourceCount: sources.length,
    independentOrigins: independentOrigins.size,
    bestTier: Number.isFinite(bestTier) ? bestTier : null,
    staleSources: stale.map(source => ({ publisher: source.publisher, retrievedOn: source.retrievedOn })),
    contradictions: contradicting.map(source => ({
      publisher: source.publisher,
      tier: source.tier,
      url: source.url,
      excerpt: source.excerpt,
    })),
    citations: sources.map(source => ({
      publisher: source.publisher,
      kind: source.kind,
      tier: source.tier,
      url: source.url,
      retrievedOn: source.retrievedOn,
      stance: source.supports ? 'supports' : 'contradicts',
    })),
  };
}

function normalizeCriteria(input) {
  if (!Array.isArray(input) || input.length === 0) fail('criteria must be a non-empty array');
  const criteria = input.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`criterion ${index} must be an object`);
    const weight = Number(raw.weight);
    if (!Number.isFinite(weight) || weight <= 0) fail(`criterion ${index} weight must be a positive number`);
    return {
      id: requireString(raw.id, `criterion ${index} id`, { maxLength: 80 }),
      label: raw.label ? requireString(raw.label, `criterion ${index} label`, { maxLength: 200 }) : requireString(raw.id, 'id'),
      weight,
      // A cost-like criterion where lower is better; scores are inverted so the
      // caller never has to remember to enter cost backwards.
      lowerIsBetter: Boolean(raw.lowerIsBetter),
    };
  });
  const ids = new Set(criteria.map(c => c.id));
  if (ids.size !== criteria.length) fail('criterion ids must be unique');
  return criteria;
}

function normalizeOptions(input, criteria) {
  if (!Array.isArray(input) || input.length < 2) fail('a decision needs at least two options');
  return input.map((raw, index) => {
    if (!isPlainObject(raw)) fail(`option ${index} must be an object`);
    const scores = {};
    for (const criterion of criteria) {
      const value = raw.scores?.[criterion.id];
      if (!Number.isFinite(Number(value))) {
        fail(`option "${raw.id ?? index}" is missing a score for "${criterion.id}"`);
      }
      const numeric = Number(value);
      if (numeric < 0 || numeric > 10) fail(`score for ${criterion.id} on ${raw.id ?? index} must be 0–10`);
      scores[criterion.id] = criterion.lowerIsBetter ? 10 - numeric : numeric;
    }
    return {
      id: requireString(raw.id, `option ${index} id`, { maxLength: 120 }),
      scores,
      // Claim ids whose truth this option's scores depend on. This is what lets
      // the matrix say "the winner rests on something unverified".
      restsOn: Array.isArray(raw.restsOn) ? raw.restsOn.map(String) : [],
      notes: raw.notes ? requireString(raw.notes, `option ${index} notes`, { maxLength: 2000 }) : null,
    };
  });
}

function weightedTotals(options, criteria) {
  const totalWeight = criteria.reduce((sum, c) => sum + c.weight, 0);
  return options
    .map(option => {
      const total = criteria.reduce((sum, c) => sum + c.weight * option.scores[c.id], 0);
      return { id: option.id, score: total / totalWeight, option };
    })
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id));
}

/**
 * Score the options, then attack the result.
 *
 * The sensitivity sweep re-runs the ranking with each criterion's weight
 * halved and doubled. If a plausible reweighting changes the winner, the
 * recommendation says so — that is the difference between a recommendation and
 * a number dressed up as one.
 */
function decisionMatrix({ question, options: rawOptions, criteria: rawCriteria, claims = [] }) {
  const criteria = normalizeCriteria(rawCriteria);
  const options = normalizeOptions(rawOptions, criteria);
  const ranked = weightedTotals(options, criteria);

  const winner = ranked[0];
  const runnerUp = ranked[1];
  // Margin as a share of the scale, not of the winner's score: a 0.2 gap means
  // the same thing whether the scores are 9.1/8.9 or 2.1/1.9.
  const margin = Number((winner.score - runnerUp.score).toFixed(3));

  const flips = [];
  for (const criterion of criteria) {
    for (const multiplier of [0.5, 2]) {
      const adjusted = criteria.map(c =>
        (c.id === criterion.id ? { ...c, weight: c.weight * multiplier } : c));
      const alternative = weightedTotals(options, adjusted)[0];
      if (alternative.id !== winner.id) {
        flips.push({
          criterion: criterion.id,
          label: criterion.label,
          multiplier,
          newWinner: alternative.id,
          note: `If ${criterion.label} matters ${multiplier > 1 ? 'twice as much' : 'half as much'} as weighted, ${alternative.id} wins instead.`,
        });
      }
    }
  }

  const claimIndex = new Map(claims.map(claim => [claim.claim, claim]));
  const shakyInputs = winner.option.restsOn
    .map(ref => claimIndex.get(ref))
    .filter(claim => claim && !claim.isSolid)
    .map(claim => ({ claim: claim.claim, confidence: claim.confidence, toSettle: claim.toSettle }));

  const robust = flips.length === 0;

  // When several criteria each flip the answer, quoting only the first one
  // understates how fragile the result is. The count is the honest headline.
  const flippingCriteria = [...new Set(flips.map(flip => flip.criterion))];
  const fragility = flippingCriteria.length > 1
    ? ` ${flippingCriteria.length} of the ${criteria.length} criteria flip the winner on their own when reweighted, so this is a close call however it is framed.`
    : '';

  let recommendation;
  if (robust && shakyInputs.length === 0) {
    recommendation = `Go with ${winner.id}. It leads by ${margin.toFixed(2)} points and stays ahead `
      + 'under every reweighting tested, so the call does not hinge on the exact weights.';
  } else if (!robust && shakyInputs.length === 0) {
    const trigger = flips[0];
    recommendation = `${winner.id} is the best choice on the weights as set, by ${margin.toFixed(2)} points, `
      + `but the answer is not weight-proof: ${trigger.note.charAt(0).toLowerCase()}${trigger.note.slice(1)}`
      + `${fragility} `
      + `Confirm ${trigger.label} is weighted the way you actually feel about it before committing.`;
  } else if (robust) {
    recommendation = `${winner.id} wins under every reweighting tested, but the case for it rests on `
      + `${shakyInputs.length} unconfirmed input${shakyInputs.length === 1 ? '' : 's'}. `
      + `Settle ${shakyInputs.length === 1 ? 'it' : 'them'} first: ${shakyInputs.map(s => s.toSettle).join(' ')}`;
  } else {
    recommendation = `${winner.id} edges it by ${margin.toFixed(2)} points, but the result is neither `
      + 'weight-proof nor fully verified. Treat this as the leading candidate, not a decision: '
      + `${flips[0].note}${fragility} And ${shakyInputs.map(s => s.toSettle).join(' ')}`;
  }

  return {
    question: requireString(question, 'question'),
    ranking: ranked.map((row, index) => ({
      rank: index + 1,
      id: row.id,
      score: Number(row.score.toFixed(3)),
      notes: row.option.notes,
    })),
    winner: winner.id,
    margin,
    robust,
    flips,
    flippingCriteria,
    shakyInputs,
    // Loud enough to survive being skimmed. A brief that buries "this rests on
    // a vendor's word" in paragraph six has not communicated it.
    confidence: robust && shakyInputs.length === 0
      ? 'high'
      : (robust || shakyInputs.length === 0 ? 'moderate' : 'low'),
    recommendation,
  };
}

module.exports = {
  ResearchError,
  SOURCE_TIERS,
  DEFAULT_FRESHNESS_DAYS,
  normalizeSource,
  verifyClaim,
  decisionMatrix,
};
