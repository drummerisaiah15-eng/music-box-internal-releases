'use strict';

// Finance administration: reconciliation and CPA hand-off.
//
// Scope boundary, enforced in the output and not just in the sales copy: this
// module organises, classifies and reconciles records. It does not decide what
// is deductible and it does not give tax advice. Every category carries a
// suggested Schedule C line so the CPA has a starting point, and every packet
// says in writing that the classifications are proposals for their review.
//
// The valuable output is not the totals — accounting software already has
// those. It is the exception list: the charges with no receipt behind them,
// which is precisely what costs money in an audit and precisely what nobody
// enjoys assembling in April.

const { parseMoney, formatMoney, slug, normalizeDocument, TaxonomyError } = require('./taxonomy');

class FinanceError extends TaxonomyError {}

function fail(message) {
  throw new FinanceError(message);
}

const DAY_MS = 24 * 60 * 60 * 1000;

// Suggested Schedule C mapping. `scheduleC` is a pointer for the CPA, not a
// determination; `substantiation` is what the file needs to have behind it
// before it is worth sending.
const EXPENSE_CATEGORIES = Object.freeze({
  advertising: { label: 'Advertising & Marketing', scheduleC: 'Line 8', substantiation: 'invoice or receipt' },
  contract_labor: { label: 'Contract Labor', scheduleC: 'Line 11', substantiation: 'invoice + W-9 on file' },
  supplies: { label: 'Supplies', scheduleC: 'Line 22', substantiation: 'itemised receipt' },
  equipment: { label: 'Equipment & Depreciable Assets', scheduleC: 'Line 13 (depreciation)', substantiation: 'itemised receipt + in-service date' },
  software: { label: 'Software & Subscriptions', scheduleC: 'Line 18 or 27a', substantiation: 'invoice or card statement line' },
  rent: { label: 'Rent & Lease', scheduleC: 'Line 20', substantiation: 'lease or invoice' },
  utilities: { label: 'Utilities', scheduleC: 'Line 25', substantiation: 'statement' },
  insurance: { label: 'Insurance', scheduleC: 'Line 15', substantiation: 'policy or invoice' },
  professional: { label: 'Legal & Professional Services', scheduleC: 'Line 17', substantiation: 'invoice' },
  travel: { label: 'Travel', scheduleC: 'Line 24a', substantiation: 'receipt + business purpose' },
  meals: { label: 'Meals', scheduleC: 'Line 24b', substantiation: 'receipt + attendees + business purpose' },
  vehicle: { label: 'Vehicle & Mileage', scheduleC: 'Line 9', substantiation: 'mileage log or receipt' },
  bank_fees: { label: 'Bank & Merchant Fees', scheduleC: 'Line 27a', substantiation: 'statement line' },
  taxes_licenses: { label: 'Taxes & Licenses', scheduleC: 'Line 23', substantiation: 'notice or receipt' },
  payroll: { label: 'Wages & Payroll', scheduleC: 'Line 26', substantiation: 'payroll report' },
  owner_draw: { label: 'Owner Draw / Non-Deductible', scheduleC: 'not a business expense', substantiation: 'none — excluded from totals' },
  personal: { label: 'Personal', scheduleC: 'not a business expense', substantiation: 'none — excluded from totals' },
  uncategorised: { label: 'Uncategorised — needs review', scheduleC: 'unknown', substantiation: 'needs the principal to identify' },
});

// Categories that must never roll into a business total. Keeping them in the
// ledger but out of the sums is the point: an excluded charge that is visible
// is auditable, an excluded charge that was deleted is not.
const NON_BUSINESS = Object.freeze(['owner_draw', 'personal']);

// Meals and travel are the two categories that reliably fail an audit on
// missing context rather than missing paper, so they are held to a higher bar.
const NEEDS_BUSINESS_PURPOSE = Object.freeze(['meals', 'travel', 'vehicle']);

function requireDateString(value, field) {
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : value;
  if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(`${field} must be a YYYY-MM-DD date`);
  }
  return text;
}

function dayDelta(a, b) {
  return Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / DAY_MS);
}

/**
 * A line lifted from a bank or card statement — the authoritative record of
 * what actually left the account.
 */
function normalizeStatementLine(input, index) {
  if (!input || Object.getPrototypeOf(input) !== Object.prototype) {
    fail(`statement line ${index} must be an object`);
  }
  return {
    id: input.id ? String(input.id) : `line-${index}`,
    date: requireDateString(input.date, `statement line ${index} date`),
    description: typeof input.description === 'string' ? input.description.trim() : '',
    amountCents: parseMoney(input.amountCents ?? input.amount, `statement line ${index} amount`),
    account: input.account ? String(input.account) : 'unspecified',
  };
}

/**
 * A document we hold — receipt, invoice, statement — extended with the
 * bookkeeping fields the naming convention does not carry.
 */
function normalizeExpenseDocument(input, index) {
  const base = normalizeDocument(input);
  const category = input.category ?? 'uncategorised';
  if (!Object.hasOwn(EXPENSE_CATEGORIES, category)) {
    fail(`document ${index} has an unknown category: ${category}`);
  }
  return {
    ...base,
    id: input.id ? String(input.id) : `doc-${index}`,
    category,
    businessPurpose: input.businessPurpose ? String(input.businessPurpose).trim() : null,
    attendees: Array.isArray(input.attendees) ? input.attendees.map(String) : [],
    path: input.path ? String(input.path) : null,
  };
}

// Vendor names arrive mangled by payment processors — "SQ *SWEETWATER 8005551212"
// against a receipt that says "Sweetwater Sound, Inc." Token overlap survives
// that; string equality does not.
const PROCESSOR_NOISE = new Set([
  'sq', 'tst', 'sp', 'pp', 'paypal', 'pos', 'purchase', 'payment', 'debit',
  'credit', 'card', 'the', 'inc', 'llc', 'co', 'com', 'ach', 'recurring', 'and',
]);

function vendorTokens(text) {
  if (!text) return new Set();
  const tokens = slug(String(text) || 'x', 'vendor', { maxLength: 120 })
    .toLowerCase()
    .split('-')
    .filter(token => token.length > 1 && !PROCESSOR_NOISE.has(token) && !/^\d+$/.test(token));
  return new Set(tokens);
}

function vendorSimilarity(a, b) {
  const left = vendorTokens(a);
  const right = vendorTokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) {
    if (right.has(token)) shared += 1;
  }
  // Containment rather than Jaccard: a statement description carrying six extra
  // junk tokens should still match a two-word vendor name cleanly.
  return shared / Math.min(left.size, right.size);
}

/**
 * Match statement lines to the documents that substantiate them.
 *
 * The amount must match to the cent. Fuzzy amount matching would produce pairs
 * that look reconciled and are not, and a wrong match is worse than an obvious
 * gap — the gap gets investigated, the wrong match gets filed.
 */
function reconcile(statementLines, documents, options = {}) {
  const dayWindow = options.dayWindow ?? 5;
  const minimumVendorSimilarity = options.minimumVendorSimilarity ?? 0;
  if (!Array.isArray(statementLines)) fail('statementLines must be an array');
  if (!Array.isArray(documents)) fail('documents must be an array');

  const lines = statementLines.map(normalizeStatementLine);
  const docs = documents.map(normalizeExpenseDocument);

  const candidates = [];
  for (const line of lines) {
    for (const doc of docs) {
      if (doc.amountCents === null) continue;
      // Statements post charges as negatives in some exports and positives in
      // others; the magnitude is what identifies the transaction.
      if (Math.abs(doc.amountCents) !== Math.abs(line.amountCents)) continue;

      const drift = Math.abs(dayDelta(line.date, doc.date));
      if (drift > dayWindow) continue;

      const similarity = vendorSimilarity(line.description, doc.counterparty);
      if (similarity < minimumVendorSimilarity) continue;

      // Vendor agreement dominates, date proximity breaks ties. Both are
      // bounded so the score stays comparable across pairs.
      const score = Math.round(similarity * 1000) + (dayWindow - drift);
      candidates.push({ line, doc, drift, similarity, score });
    }
  }

  // Greedy one-to-one assignment, best score first. Ties break on ids so the
  // same inputs always reconcile the same way — a reconciliation that shuffles
  // between runs cannot be reviewed.
  candidates.sort((a, b) =>
    (b.score - a.score)
    || a.line.id.localeCompare(b.line.id)
    || a.doc.id.localeCompare(b.doc.id));

  const takenLines = new Set();
  const takenDocs = new Set();
  const matched = [];

  for (const candidate of candidates) {
    if (takenLines.has(candidate.line.id) || takenDocs.has(candidate.doc.id)) continue;
    takenLines.add(candidate.line.id);
    takenDocs.add(candidate.doc.id);
    matched.push({
      lineId: candidate.line.id,
      documentId: candidate.doc.id,
      date: candidate.line.date,
      amountCents: candidate.line.amountCents,
      vendor: candidate.doc.counterparty,
      driftDays: candidate.drift,
      vendorSimilarity: Number(candidate.similarity.toFixed(3)),
      // Below this the amount and date agree but the names do not, which is
      // usually right and occasionally a coincidence. Flagged, not hidden.
      confidence: candidate.similarity >= 0.5 ? 'high' : 'needs-eyes',
    });
  }

  const unreceipted = lines
    .filter(line => !takenLines.has(line.id))
    .map(line => ({
      lineId: line.id,
      date: line.date,
      description: line.description,
      amountCents: line.amountCents,
      account: line.account,
      exposure: 'money left the account with no document behind it',
    }));

  const unmatchedDocuments = docs
    .filter(doc => !takenDocs.has(doc.id))
    .map(doc => ({
      documentId: doc.id,
      date: doc.date,
      vendor: doc.counterparty,
      amountCents: doc.amountCents,
      exposure: 'document with no matching statement line — paid another way, duplicated, or dated wrong',
    }));

  const totalLineCents = lines.reduce((sum, line) => sum + Math.abs(line.amountCents), 0);
  const matchedCents = matched.reduce((sum, row) => sum + Math.abs(row.amountCents), 0);

  return {
    matched,
    unreceipted,
    unmatchedDocuments,
    coverage: {
      lines: lines.length,
      matchedLines: matched.length,
      // Dollar coverage is the number that matters for audit exposure; a single
      // missing five-figure receipt outweighs forty missing coffee receipts.
      byCount: lines.length === 0 ? 1 : Number((matched.length / lines.length).toFixed(4)),
      byDollars: totalLineCents === 0 ? 1 : Number((matchedCents / totalLineCents).toFixed(4)),
      unreceiptedCents: totalLineCents - matchedCents,
    },
  };
}

/**
 * Totals by category, business and non-business kept apart.
 */
function categorySummary(documents) {
  const docs = documents.map(normalizeExpenseDocument);
  const buckets = new Map();

  for (const doc of docs) {
    const bucket = buckets.get(doc.category) ?? {
      category: doc.category,
      label: EXPENSE_CATEGORIES[doc.category].label,
      scheduleC: EXPENSE_CATEGORIES[doc.category].scheduleC,
      count: 0,
      totalCents: 0,
      businessDeductible: !NON_BUSINESS.includes(doc.category),
    };
    bucket.count += 1;
    bucket.totalCents += Math.abs(doc.amountCents ?? 0);
    buckets.set(doc.category, bucket);
  }

  const rows = [...buckets.values()].sort((a, b) =>
    (b.totalCents - a.totalCents) || a.category.localeCompare(b.category));

  return {
    rows,
    businessTotalCents: rows.filter(r => r.businessDeductible).reduce((s, r) => s + r.totalCents, 0),
    excludedTotalCents: rows.filter(r => !r.businessDeductible).reduce((s, r) => s + r.totalCents, 0),
  };
}

/**
 * Everything wrong with the file, as a list a person can work through.
 *
 * Ordered worst-first by dollar exposure, because the point of the list is to
 * be actioned in a finite amount of time, not admired.
 */
function findGaps(documents) {
  const docs = documents.map(normalizeExpenseDocument);
  const gaps = [];

  for (const doc of docs) {
    if (doc.category === 'uncategorised') {
      gaps.push({
        documentId: doc.id,
        severity: 'blocking',
        amountCents: Math.abs(doc.amountCents ?? 0),
        issue: `${doc.counterparty} on ${doc.date} has no category`,
        ask: 'Confirm what this was for so it can be classified.',
      });
    }
    if (NEEDS_BUSINESS_PURPOSE.includes(doc.category) && !doc.businessPurpose) {
      gaps.push({
        documentId: doc.id,
        severity: 'blocking',
        amountCents: Math.abs(doc.amountCents ?? 0),
        issue: `${EXPENSE_CATEGORIES[doc.category].label} on ${doc.date} has no business purpose recorded`,
        ask: `Substantiation required: ${EXPENSE_CATEGORIES[doc.category].substantiation}.`,
      });
    }
    if (doc.category === 'meals' && doc.attendees.length === 0) {
      gaps.push({
        documentId: doc.id,
        severity: 'advisory',
        amountCents: Math.abs(doc.amountCents ?? 0),
        issue: `Meal on ${doc.date} lists no attendees`,
        ask: 'Name who was there; the deduction is weaker without it.',
      });
    }
    if (doc.amountCents === null) {
      gaps.push({
        documentId: doc.id,
        severity: 'blocking',
        amountCents: 0,
        issue: `${doc.counterparty} on ${doc.date} has no amount recorded`,
        ask: 'Read the amount off the document, or replace an unreadable scan.',
      });
    }
  }

  const severityRank = { blocking: 0, advisory: 1 };
  gaps.sort((a, b) =>
    (severityRank[a.severity] - severityRank[b.severity])
    || (b.amountCents - a.amountCents)
    || a.documentId.localeCompare(b.documentId));
  return gaps;
}

/**
 * The deliverable: what actually gets sent to the CPA, plus the honest list of
 * what is still missing. A packet that hides its own gaps wastes a billable
 * hour and a round trip.
 */
function cpaPacket({ taxYear, entity, documents = [], statementLines = [], preparedOn }, options = {}) {
  if (!Number.isInteger(taxYear)) fail('cpaPacket requires an integer taxYear');
  const entityCode = slug(entity ?? 'ENTITY', 'entity', { maxLength: 24 }).toUpperCase();
  const preparedDate = requireDateString(preparedOn ?? new Date().toISOString().slice(0, 10), 'preparedOn');

  const inYear = documents.filter(doc => normalizeDocument(doc).taxYear === taxYear);
  const linesInYear = statementLines.filter(line =>
    Number(requireDateString(line.date, 'statement line date').slice(0, 4)) === taxYear);

  const reconciliation = reconcile(linesInYear, inYear, options);
  const summary = categorySummary(inYear);
  const gaps = findGaps(inYear);

  const blocking = gaps.filter(gap => gap.severity === 'blocking').length;
  const openQuestions = [
    ...gaps.filter(gap => gap.severity === 'blocking').map(gap => `${gap.issue} — ${gap.ask}`),
    ...reconciliation.unreceipted.slice(0, 25).map(row =>
      `${row.date} ${row.description || '(no description)'} ${formatMoney(Math.abs(row.amountCents))} has no receipt — locate it or confirm it was personal.`),
  ];

  // A single honest number for "is this ready to send". Dollar coverage is
  // weighted over item count for the same reason it is in `reconcile`.
  const readiness = Math.round(
    100 * (0.7 * reconciliation.coverage.byDollars
      + 0.3 * (inYear.length === 0 ? 0 : 1 - Math.min(1, blocking / inYear.length))),
  );

  return {
    taxYear,
    entity: entityCode,
    preparedOn: preparedDate,
    scopeNote:
      'Prepared as organised records for CPA review. Category and Schedule C references are '
      + 'proposals to speed up the CPA\'s work, not tax determinations, and no deductibility '
      + 'conclusion has been reached here.',
    documentCount: inYear.length,
    statementLineCount: linesInYear.length,
    totals: {
      businessTotal: formatMoney(summary.businessTotalCents),
      businessTotalCents: summary.businessTotalCents,
      excludedTotal: formatMoney(summary.excludedTotalCents),
      excludedTotalCents: summary.excludedTotalCents,
    },
    byCategory: summary.rows.map(row => ({ ...row, total: formatMoney(row.totalCents) })),
    reconciliation: {
      ...reconciliation.coverage,
      unreceiptedTotal: formatMoney(reconciliation.coverage.unreceiptedCents),
      unreceipted: reconciliation.unreceipted,
      unmatchedDocuments: reconciliation.unmatchedDocuments,
      lowConfidenceMatches: reconciliation.matched.filter(row => row.confidence === 'needs-eyes'),
    },
    gaps,
    openQuestions,
    readiness,
    readyToSend: blocking === 0 && reconciliation.coverage.byDollars >= (options.sendThreshold ?? 0.95),
  };
}

module.exports = {
  FinanceError,
  EXPENSE_CATEGORIES,
  NON_BUSINESS,
  NEEDS_BUSINESS_PURPOSE,
  normalizeStatementLine,
  normalizeExpenseDocument,
  vendorSimilarity,
  reconcile,
  categorySummary,
  findGaps,
  cpaPacket,
};
