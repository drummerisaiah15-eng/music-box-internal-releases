'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCsv, sniffDelimiter, detectDateFormat, parseDate, importStatementCsv, CsvError } = require('../src/csv');

const US = `Transaction Date,Post Date,Description,Category,Type,Amount,Memo
03/14/2026,03/16/2026,"SQ *SWEETWATER SOUND, INC 8005551212",Shopping,Sale,-1284.99,
03/02/2026,03/03/2026,TST* BLUE BOTTLE #22,Food & Drink,Sale,-42.10,
03/20/2026,03/21/2026,PAYMENT THANK YOU,,Payment,1500.00,
`;

const UK = `Account: Northside Music Ltd
Statement period: 01/03/2026 to 31/03/2026

Date;Details;Money Out;Money In;Balance
14/03/2026;SWEETWATER SOUND;1284.99;;4211.02
25/03/2026;CUSTOMER PAYMENT;;2000.00;6211.02
Closing balance;;;;6211.02
`;

test('a quoted field containing the delimiter stays one field', () => {
  const rows = parseCsv('a,b\n"one, two",three\n');
  assert.deepEqual(rows[1], ['one, two', 'three']);
});

test('doubled quotes decode to a literal quote', () => {
  assert.deepEqual(parseCsv('a\n"He said ""hi"""\n')[1], ['He said "hi"']);
});

test('a newline inside a quoted field does not split the row', () => {
  const rows = parseCsv('a,b\n"line one\nline two",x\n');
  assert.equal(rows.length, 2);
  assert.equal(rows[1][0], 'line one\nline two');
});

test('an unclosed quote is refused rather than half-read', () => {
  assert.throws(() => parseCsv('a,b\n"never closed,x\n'), /unclosed quoted field/);
});

test('CRLF and a BOM are handled', () => {
  const rows = parseCsv('﻿a,b\r\n1,2\r\n');
  assert.deepEqual(rows[0], ['a', 'b']);
  assert.deepEqual(rows[1], ['1', '2']);
});

test('the delimiter is chosen by column consistency, not by frequency', () => {
  // Commas outnumber semicolons here, but only semicolons give a stable shape.
  const text = 'Date;Details;Amount\n01/01/2026;"Smith, Jones, and Co";10.00\n02/01/2026;"A, B, C, D";20.00\n';
  assert.equal(sniffDelimiter(text), ';');
});

test('tab-separated files are recognised', () => {
  assert.equal(sniffDelimiter('a\tb\tc\n1\t2\t3\n'), '\t');
});

test('a day above 12 proves the convention for the whole file', () => {
  assert.equal(detectDateFormat(['03/04/2026', '14/03/2026']), 'day-first');
  assert.equal(detectDateFormat(['03/04/2026', '03/14/2026']), 'month-first');
});

test('ISO dates need no inference', () => {
  assert.equal(detectDateFormat(['2026-03-14', '2026-03-02']), 'iso');
});

// The accuracy rule this module exists for.
test('a wholly ambiguous date column is refused, with the remedy', () => {
  assert.throws(() => detectDateFormat(['03/04/2026', '05/06/2026']), /ambiguous/);
  try {
    detectDateFormat(['03/04/2026']);
  } catch (error) {
    assert.match(error.message, /--date-format/);
    assert.match(error.message, /YYYY-MM-DD/);
  }
});

test('a column containing both conventions is refused', () => {
  assert.throws(() => detectDateFormat(['14/03/2026', '03/14/2026']), /both day-first and month-first/);
});

test('dates parse per the detected convention', () => {
  assert.equal(parseDate('03/04/2026', 'day-first'), '2026-04-03');
  assert.equal(parseDate('03/04/2026', 'month-first'), '2026-03-04');
  assert.equal(parseDate('2026-03-14', 'iso'), '2026-03-14');
  assert.equal(parseDate('14/03/26', 'day-first'), '2026-03-14', 'two-digit years');
});

test('an impossible date is refused', () => {
  assert.throws(() => parseDate('31/02/2026', 'day-first'), /not a real calendar date/);
});

test('a US card export reads correctly', () => {
  const { records, report } = importStatementCsv(US, { account: 'amex' });
  assert.equal(report.dateFormat, 'month-first');
  assert.equal(records.length, 3);
  assert.equal(records[0].date, '2026-03-14');
  assert.equal(records[0].amountCents, -128499);
  assert.match(records[0].description, /SWEETWATER SOUND, INC/, 'the quoted comma survived');
});

test('a UK bank export with preamble and a debit/credit pair reads correctly', () => {
  const { records, report } = importStatementCsv(UK);
  assert.equal(report.dateFormat, 'day-first');
  assert.equal(report.headerRow, 4, 'the real line in the file, counting the blank line');
  assert.equal(report.columns.debit, 'Money Out');
  assert.equal(records.length, 2);
  assert.equal(records[0].amountCents, -128499, 'money out is negative');
  assert.equal(records[1].amountCents, 200000, 'money in is positive');
});

test('summary rows are skipped and reported, never silently dropped', () => {
  const { report } = importStatementCsv(UK);
  assert.equal(report.skipped.length, 1);
  assert.match(report.skipped[0].reason, /summary row/);
});

// Money in is not an audit exposure, and counting it as one overstates the
// single number this whole exercise reports.
test('direction is set so credits are not treated as missing receipts', () => {
  const { records, report } = importStatementCsv(US);
  assert.equal(report.debits, 2);
  assert.equal(report.credits, 1);
  assert.equal(records.find(r => /PAYMENT/.test(r.description)).direction, 'credit');
  assert.match(report.signConvention, /negative amounts read as money out/);
});

test('direction is certain when the file has debit and credit columns', () => {
  const { report } = importStatementCsv(UK);
  assert.equal(report.signConvention, 'explicit debit/credit columns');
});

test('a bank that exports charges as positive is read the right way round', () => {
  const positive = `Date,Description,Amount
2026-03-14,SWEETWATER,1284.99
2026-03-02,BLUE BOTTLE,42.10
2026-03-20,PAYMENT RECEIVED,-1500.00
`;
  const { records, report } = importStatementCsv(positive);
  assert.match(report.signConvention, /positive amounts read as money out/);
  assert.equal(records.find(r => /PAYMENT/.test(r.description)).direction, 'credit');
  assert.equal(report.debits, 2);
});

test('re-importing the same file produces the same ids', () => {
  const a = importStatementCsv(US).records.map(record => record.sourceId);
  const b = importStatementCsv(US).records.map(record => record.sourceId);
  assert.deepEqual(a, b, 'otherwise every import would duplicate the statement');
});

// Two identical charges on one day is a real thing, and dropping one would
// understate what was spent.
test('genuinely identical charges both survive, and are flagged', () => {
  const twice = `Date,Description,Amount
2026-03-14,SWEETWATER SOUND,-42.10
2026-03-14,SWEETWATER SOUND,-42.10
`;
  const { records, report } = importStatementCsv(twice);
  assert.equal(records.length, 2);
  assert.notEqual(records[0].sourceId, records[1].sourceId);
  assert.equal(report.duplicateGroups.length, 1);
});

test('a row with no amount is skipped with its line number', () => {
  const gappy = `Date,Description,Amount
2026-03-14,SWEETWATER,-42.10
2026-03-15,MYSTERY,
`;
  const { records, report } = importStatementCsv(gappy);
  assert.equal(records.length, 1);
  assert.equal(report.skipped[0].line, 3);
});

test('a file with no usable header is refused with what it saw', () => {
  assert.throws(() => importStatementCsv('foo,bar\n1,2\n'), /could not find a header row/);
  assert.throws(() => importStatementCsv('foo,bar\n1,2\n'), CsvError);
});

test('an explicit date format overrides detection on an ambiguous file', () => {
  const ambiguous = 'Date,Description,Amount\n03/04/2026,X,-10.00\n';
  assert.throws(() => importStatementCsv(ambiguous));
  assert.equal(importStatementCsv(ambiguous, { dateFormat: 'day-first' }).records[0].date, '2026-04-03');
  assert.equal(importStatementCsv(ambiguous, { dateFormat: 'month-first' }).records[0].date, '2026-03-04');
});

test('the transaction date is preferred over the posting date', () => {
  const { report, records } = importStatementCsv(US);
  assert.equal(report.columns.date, 'Transaction Date');
  assert.equal(records[0].date, '2026-03-14', 'not the 16th, which is when it posted');
});
