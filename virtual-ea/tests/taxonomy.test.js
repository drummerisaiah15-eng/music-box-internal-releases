'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  slug, parseMoney, formatMoney, buildFileName, parseFileName,
  buildFolderPath, buildFullPath, auditPaths, TaxonomyError,
} = require('../src/taxonomy');

const RECORD = Object.freeze({
  date: '2026-03-14',
  entity: 'MBX',
  docType: 'RECEIPT',
  counterparty: 'Sweetwater Sound, Inc.',
  amountCents: 128499,
  reference: 'INV-10233',
  extension: 'pdf',
});

test('the same vendor written differently produces one token', () => {
  const forms = ['Sweetwater Sound, Inc.', 'sweetwater sound inc', 'SWEETWATER   SOUND  INC.'];
  const tokens = new Set(forms.map(form => slug(form, 'vendor')));
  assert.equal(tokens.size, 1, 'otherwise the same vendor files in two places and year-end totals split');
});

test('accents are folded rather than dropped', () => {
  assert.equal(slug('Café Münster & Co', 'vendor'), 'Cafe-Munster-And-Co');
  assert.equal(slug('cafe munster and co', 'vendor'), 'Cafe-Munster-And-Co', 'and folds to the same token');
});

test('a name with nothing filename-safe in it is refused', () => {
  assert.throws(() => slug('!!!', 'vendor'), TaxonomyError);
});

test('money parses from every form a human or a bank writes it', () => {
  assert.equal(parseMoney('$1,284.99'), 128499);
  assert.equal(parseMoney('1284.99'), 128499);
  assert.equal(parseMoney('-$1,284.99'), -128499);
  assert.equal(parseMoney('($1,284.99)'), -128499, 'accounting-style negatives');
  assert.equal(parseMoney('( $1,284.99 )'), -128499, 'padding inside the parentheses is safe to trim');
  assert.equal(parseMoney('1284.9'), 128490, 'a single decimal place means tenths');
  assert.equal(parseMoney('0.07'), 7);
  assert.equal(parseMoney(128499), 128499);
});

test('money that cannot be read is refused, never guessed', () => {
  for (const bad of ['about $50', '', '1.234', 'twelve dollars', '$1,2 84.99']) {
    assert.throws(() => parseMoney(bad), TaxonomyError, `accepted "${bad}"`);
  }
});

test('cents survive a round trip through formatting', () => {
  for (const cents of [0, 7, 100, 128499, -128499, 999999999]) {
    assert.equal(parseMoney(formatMoney(cents)), cents);
  }
});

test('float arithmetic never touches a total', () => {
  // 0.1 + 0.2 in cents is exactly 30, which is the entire reason for the choice.
  assert.equal(parseMoney('0.10') + parseMoney('0.20'), 30);
});

test('a filename round-trips back to its record', () => {
  const name = buildFileName(RECORD);
  assert.equal(name, '2026-03-14__MBX__RECEIPT__Sweetwater-Sound-Inc__USD1284-99__INV-10233.pdf');
  assert.equal(parseFileName(name).reference, 'INV-10233', 'a reference is an external id; its case is signal');
  const parsed = parseFileName(name);
  assert.equal(parsed.date, RECORD.date);
  assert.equal(parsed.entity, 'MBX');
  assert.equal(parsed.docType, 'RECEIPT');
  assert.equal(parsed.amountCents, 128499);
  assert.equal(parsed.reference, 'INV-10233');
  assert.equal(buildFileName(parsed), name, 'reparsing must be a fixed point');
});

test('refunds are visibly distinct from charges in the name itself', () => {
  const refund = buildFileName({ ...RECORD, amountCents: -128499 });
  assert.match(refund, /NEG1284-99/);
  assert.equal(parseFileName(refund).amountCents, -128499);
});

test('a document with no amount still files cleanly', () => {
  const name = buildFileName({ ...RECORD, amountCents: null, reference: null });
  assert.match(name, /NOAMT__NOREF/);
  assert.equal(parseFileName(name).amountCents, null);
  assert.equal(parseFileName(name).reference, null);
});

test('impossible calendar dates are refused', () => {
  assert.throws(() => buildFileName({ ...RECORD, date: '2026-02-31' }), /not a real calendar date/);
  assert.throws(() => buildFileName({ ...RECORD, date: '03/14/2026' }), /YYYY-MM-DD/);
});

test('vendor names containing the separator cannot corrupt the parse', () => {
  const name = buildFileName({ ...RECORD, counterparty: 'Weird__Vendor__Name' });
  assert.equal(parseFileName(name).counterparty, 'Weird-Vendor-Name');
});

test('the folder is derived from the document, not chosen by hand', () => {
  assert.equal(buildFolderPath(RECORD), 'Finance/2026/MBX/02_Receipts');
  assert.equal(buildFolderPath({ ...RECORD, docType: 'STATEMENT' }), 'Finance/2026/MBX/01_Statements');
  assert.equal(buildFolderPath(RECORD, { root: 'Clients/Acme' }), 'Clients/Acme/2026/MBX/02_Receipts');
});

test('tax year sits above entity so a year hands over as one folder copy', () => {
  const parts = buildFolderPath(RECORD).split('/');
  assert.equal(parts[1], '2026');
  assert.ok(parts.indexOf('2026') < parts.indexOf('MBX'));
});

test('an explicit tax year overrides the document date for straddling documents', () => {
  // A January invoice for December work belongs in the prior year's file.
  const straddle = { ...RECORD, date: '2027-01-08', taxYear: 2026 };
  assert.match(buildFolderPath(straddle), /Finance\/2026\//);
});

test('the audit finds files sitting in the wrong folder for their own metadata', () => {
  const [finding] = auditPaths(['Finance/2026/MBX/09_Unsorted/2026-03-14__MBX__RECEIPT__Acme__USD10-00__NOREF.pdf']);
  assert.equal(finding.ok, false);
  assert.equal(finding.suggestion, 'Finance/2026/MBX/02_Receipts/2026-03-14__MBX__RECEIPT__Acme__USD10-00__NOREF.pdf');
});

test('the audit reports likely duplicates instead of silently collapsing them', () => {
  const findings = auditPaths([
    'Finance/2026/MBX/02_Receipts/2026-03-14__MBX__RECEIPT__Acme__USD10-00__NOREF.pdf',
    'Finance/2026/MBX/02_Receipts/2026-03-14__MBX__RECEIPT__Acme__USD10-00__ref2.pdf',
  ]);
  assert.equal(findings[0].ok, true);
  assert.match(findings[1].issue, /possible duplicate/);
});

test('the audit reports on every file rather than stopping at the first problem', () => {
  const findings = auditPaths(['not-a-convention.pdf', 'Finance/2026/MBX/02_Receipts/2026-03-14__MBX__RECEIPT__Acme__USD10-00__NOREF.pdf']);
  assert.equal(findings.length, 2);
  assert.equal(findings[0].ok, false);
  assert.equal(findings[1].ok, true);
});

test('buildFullPath is folder and name agreeing with each other', () => {
  const full = buildFullPath(RECORD);
  assert.equal(full, `${buildFolderPath(RECORD)}/${buildFileName(RECORD)}`);
  assert.deepEqual(auditPaths([full])[0], { path: full, ok: true, issue: null, suggestion: null });
});
