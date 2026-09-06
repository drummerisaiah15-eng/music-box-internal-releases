'use strict';

// Bank and card statement import.
//
// Every bank exports CSV and no two export the same CSV. Columns are named
// differently, dates are written differently, and the amount is sometimes one
// signed column and sometimes a debit/credit pair. The job here is to read all
// of them without ever quietly guessing, because a statement misread by a
// factor of a day or a sign produces a reconciliation that looks right and is
// not.
//
// The rule this module follows throughout: when the data is genuinely
// ambiguous, refuse and say what would resolve it. `03/04/2026` is either the
// 3rd of April or the 4th of March, and picking one silently is how a quarter
// ends up misfiled.

const crypto = require('node:crypto');

const { LedgerError } = require('./ledger');
const { parseMoney, slug } = require('./taxonomy');

class CsvError extends LedgerError {}

function fail(message) {
  throw new CsvError(message);
}

/**
 * RFC 4180 parser.
 *
 * Written out rather than pulled from a dependency because the awkward cases —
 * a quoted merchant name containing the delimiter, an embedded newline in a
 * memo field, a doubled quote inside a quoted field — are exactly the ones a
 * naive `split(',')` gets wrong, and those rows are transactions.
 */
function parseCsvRows(text, { delimiter } = {}) {
  if (typeof text !== 'string') fail('CSV input must be a string');
  const source = text.replace(/^﻿/, '');       // strip a UTF-8 BOM
  const sep = delimiter ?? sniffDelimiter(source);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  let i = 0;
  // Physical line numbers are tracked because blank and summary rows get
  // dropped, and a skip reported against the wrong line sends someone hunting
  // through a spreadsheet for a row that reads fine.
  let line = 1;
  let rowStartLine = 1;

  const endRow = () => {
    row.push(field); field = '';
    rows.push({ line: rowStartLine, cells: row });
    row = [];
  };

  while (i < source.length) {
    const char = source[i];

    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i += 1; continue;
      }
      // A newline inside a quoted field still advances the physical line.
      if (char === '\n') line += 1;
      field += char; i += 1; continue;
    }

    if (char === '"' && field === '') { quoted = true; i += 1; continue; }
    if (char === sep) { row.push(field); field = ''; i += 1; continue; }

    if (char === '\r' || char === '\n') {
      endRow();
      i += (char === '\r' && source[i + 1] === '\n') ? 2 : 1;
      line += 1;
      rowStartLine = line;
      continue;
    }
    field += char; i += 1;
  }

  if (quoted) fail('CSV ends inside an unclosed quoted field');
  if (field !== '' || row.length > 0) endRow();

  return rows
    .map(({ line: at, cells }) => ({ line: at, cells: cells.map(cell => cell.trim()) }))
    .filter(({ cells }) => cells.some(cell => cell !== ''));
}

function parseCsv(text, options) {
  return parseCsvRows(text, options).map(row => row.cells);
}

// Pick the delimiter that yields the most consistent column count across the
// first several lines. Counting occurrences alone is fooled by a comma-heavy
// description column in a semicolon-delimited file.
function sniffDelimiter(text) {
  const sample = text.split(/\r?\n/).filter(Boolean).slice(0, 10);
  if (sample.length === 0) fail('CSV input is empty');

  let best = { delimiter: ',', score: -1 };
  for (const delimiter of [',', ';', '\t', '|']) {
    const counts = sample.map(line => line.split(delimiter).length);
    const columns = Math.max(...counts);
    if (columns < 2) continue;
    const consistent = counts.filter(count => count === columns).length;
    const score = consistent * 100 + columns;
    if (score > best.score) best = { delimiter, score };
  }
  // Nothing produced more than one column, so the file has no delimiter to
  // find. Any separator parses it identically; comma is the conventional pick.
  if (best.score < 0) return ',';
  return best.delimiter;
}

// Header synonyms, most specific first. The transaction date is preferred over
// the posting date: it is what the receipt in your hand will say.
const COLUMN_SYNONYMS = Object.freeze({
  date: ['transaction date', 'trans date', 'trans. date', 'date', 'posted date', 'post date', 'posting date'],
  description: ['description', 'merchant', 'payee', 'name', 'details', 'narrative', 'transaction', 'memo', 'reference'],
  amount: ['amount', 'transaction amount', 'value'],
  debit: ['debit', 'withdrawal', 'withdrawals', 'money out', 'paid out', 'charges'],
  credit: ['credit', 'deposit', 'deposits', 'money in', 'paid in', 'payments'],
});

function normaliseHeader(text) {
  return text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Find the header row and map it to the fields we need.
 *
 * Some exports emit a preamble — account name, date range, blank lines —
 * before the real header, so the header is searched for rather than assumed to
 * be line one.
 */
function locateColumns(rows) {
  const limit = Math.min(rows.length, 25);
  for (let index = 0; index < limit; index += 1) {
    const headers = rows[index].cells.map(normaliseHeader);
    const mapping = {};

    for (const [field, synonyms] of Object.entries(COLUMN_SYNONYMS)) {
      for (const synonym of synonyms) {
        const at = headers.findIndex((header, column) =>
          header === synonym && !Object.values(mapping).includes(column));
        if (at >= 0) { mapping[field] = at; break; }
      }
    }

    const hasAmount = mapping.amount !== undefined
      || (mapping.debit !== undefined || mapping.credit !== undefined);
    if (mapping.date !== undefined && mapping.description !== undefined && hasAmount) {
      return { headerIndex: index, headerLine: rows[index].line, mapping, headers: rows[index].cells };
    }
  }

  const seen = rows[0] ? rows[0].cells.join(', ') : '(no rows)';
  fail(
    'could not find a header row with a date, a description and an amount. '
    + `First row seen: ${seen}. Rename the columns or pass an explicit mapping.`,
  );
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const SPLIT_DATE = /^(\d{1,4})[/\-.](\d{1,2})[/\-.](\d{1,4})$/;

/**
 * Work out the date convention from the whole column before reading any single
 * value.
 *
 * A file is only unambiguous if some row proves it: a first component above 12
 * proves day-first, a second component above 12 proves month-first. Absent
 * either proof the file is genuinely undecidable and is refused.
 */
function detectDateFormat(values) {
  let iso = 0;
  let dayFirstProof = 0;
  let monthFirstProof = 0;
  let parseable = 0;

  for (const value of values) {
    if (ISO_DATE.test(value)) { iso += 1; parseable += 1; continue; }
    const match = SPLIT_DATE.exec(value);
    if (!match) continue;
    parseable += 1;
    const [, a, b] = match;
    if (Number(a) > 12) dayFirstProof += 1;
    if (Number(b) > 12) monthFirstProof += 1;
  }

  if (parseable === 0) fail('no readable dates found in the date column');
  if (iso === parseable) return 'iso';

  if (dayFirstProof > 0 && monthFirstProof > 0) {
    fail(
      'the date column contains both day-first and month-first rows and cannot be read as one '
      + 'convention. Export again from the bank with ISO (YYYY-MM-DD) dates.',
    );
  }
  if (dayFirstProof > 0) return 'day-first';
  if (monthFirstProof > 0) return 'month-first';

  fail(
    'every date in this file is ambiguous — no row has a day above 12, so 03/04/2026 could be '
    + 'either 3 April or 4 March. Pass --date-format day-first or --date-format month-first, or '
    + 're-export with ISO (YYYY-MM-DD) dates.',
  );
}

function expandYear(year) {
  const value = Number(year);
  if (year.length === 4) return value;
  // A two-digit year in a bank statement is not going to be 1972.
  return value >= 70 ? 1900 + value : 2000 + value;
}

function parseDate(value, format) {
  const iso = ISO_DATE.exec(value);
  if (iso) return value;

  const match = SPLIT_DATE.exec(value);
  if (!match) fail(`unreadable date: ${value}`);
  const [, a, b, c] = match;

  let year;
  let month;
  let day;
  if (a.length === 4) {
    [year, month, day] = [Number(a), Number(b), Number(c)];
  } else if (format === 'day-first') {
    [day, month, year] = [Number(a), Number(b), expandYear(c)];
  } else {
    [month, day, year] = [Number(a), Number(b), expandYear(c)];
  }

  const text = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  const parsed = new Date(`${text}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(`${value} is not a real calendar date`);
  }
  return text;
}

// Rows banks append that are not transactions.
const NON_TRANSACTION = /^(closing|opening|total|balance|statement|subtotal)\b/i;

/**
 * A statement row's identity.
 *
 * A CSV has no row ids, so one is synthesised from the transaction's own
 * content plus its ordinal among rows identical to it. That makes re-importing
 * the same file a no-op, while still keeping two genuinely identical charges
 * on the same day as two rows — which is a real thing that happens, and losing
 * one of them would silently understate what was spent.
 */
function rowIdentity(date, description, cents, occurrence) {
  const digest = crypto
    .createHash('sha256')
    .update(`${date}|${normaliseHeader(description)}|${cents}`)
    .digest('hex')
    .slice(0, 12);
  return occurrence === 0 ? digest : `${digest}-${occurrence + 1}`;
}

/**
 * Read a statement export into records the sync engine can merge.
 *
 * Returns the rows plus a report of what was skipped and why, because a silent
 * skip in a financial import is indistinguishable from a missing transaction.
 */
function importStatementCsv(text, options = {}) {
  const rows = parseCsvRows(text, options);
  const { headerIndex, headerLine, mapping, headers } = locateColumns(rows);
  const body = rows.slice(headerIndex + 1);

  const cell = (row, field) => (mapping[field] === undefined ? '' : (row.cells[mapping[field]] ?? '').trim());

  const dateFormat = options.dateFormat
    ?? detectDateFormat(body.map(row => cell(row, 'date')).filter(Boolean));

  const records = [];
  const skipped = [];
  const occurrences = new Map();
  const usedDebitCredit = mapping.amount === undefined;

  body.forEach((row) => {
    const line = row.line;                   // the real line in the user's file
    const rawDate = cell(row, 'date');
    const description = cell(row, 'description');

    if (!rawDate && !description) return;
    if (NON_TRANSACTION.test(description) || NON_TRANSACTION.test(rawDate)) {
      skipped.push({ line, reason: 'summary row, not a transaction', text: description || rawDate });
      return;
    }

    let date;
    try {
      date = parseDate(rawDate, dateFormat);
    } catch (error) {
      skipped.push({ line, reason: error.message, text: rawDate });
      return;
    }

    let cents;
    try {
      if (mapping.amount !== undefined && cell(row, 'amount')) {
        cents = parseMoney(cell(row, 'amount'), `amount on line ${line}`);
      } else {
        // Debit/credit pair: money out is negative, money in positive.
        const debit = cell(row, 'debit');
        const credit = cell(row, 'credit');
        if (debit && credit) {
          skipped.push({ line, reason: 'both a debit and a credit are filled in', text: `${debit} / ${credit}` });
          return;
        }
        if (!debit && !credit) {
          skipped.push({ line, reason: 'no amount in any amount column', text: description });
          return;
        }
        cents = debit
          ? -Math.abs(parseMoney(debit, `debit on line ${line}`))
          : Math.abs(parseMoney(credit, `credit on line ${line}`));
      }
    } catch (error) {
      skipped.push({ line, reason: error.message, text: cell(row, 'amount') });
      return;
    }

    if (!description) {
      skipped.push({ line, reason: 'no description — cannot be matched to a receipt', text: rawDate });
      return;
    }

    const fingerprint = `${date}|${normaliseHeader(description)}|${cents}`;
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);

    records.push({
      sourceId: rowIdentity(date, description, cents, occurrence),
      date,
      description,
      amountCents: cents,
      // Known for certain from a debit/credit pair. For a single signed column
      // it is left unset here and inferred below from the file as a whole.
      direction: usedDebitCredit ? (cents < 0 ? 'debit' : 'credit') : undefined,
      account: options.account ?? 'unspecified',
    });
  });

  // For a single signed amount column the bank's convention has to be read off
  // the data. On any real statement most rows are spending, so the dominant
  // sign is money out. That is an inference, so it is reported rather than
  // buried — a file where it guessed wrong would report every charge as income.
  let signConvention = usedDebitCredit ? 'explicit debit/credit columns' : null;
  if (!usedDebitCredit) {
    const negatives = records.filter(record => record.amountCents < 0).length;
    const positives = records.length - negatives;
    const debitsAreNegative = negatives >= positives;
    signConvention = debitsAreNegative
      ? 'negative amounts read as money out'
      : 'positive amounts read as money out';
    for (const record of records) {
      const isDebit = debitsAreNegative ? record.amountCents < 0 : record.amountCents > 0;
      record.direction = isDebit ? 'debit' : 'credit';
    }
  }

  return {
    records,
    report: {
      dateFormat,
      signConvention,
      debits: records.filter(record => record.direction === 'debit').length,
      credits: records.filter(record => record.direction === 'credit').length,
      delimiter: options.delimiter ?? sniffDelimiter(text.replace(/^﻿/, '')),
      headerRow: headerLine,
      headers,
      columns: Object.fromEntries(
        Object.entries(mapping).map(([field, column]) => [field, headers[column]]),
      ),
      imported: records.length,
      skipped,
      // A duplicate fingerprint is usually two real identical charges, but it
      // is occasionally a double-exported file, so it is surfaced either way.
      duplicateGroups: [...occurrences.entries()]
        .filter(([, count]) => count > 1)
        .map(([fingerprint, count]) => ({ fingerprint, count })),
    },
  };
}

function summariseImport(report) {
  const lines = [
    `Read ${report.imported} transactions (${report.dateFormat} dates, header on line ${report.headerRow}).`,
    `Columns used: ${Object.entries(report.columns).map(([f, h]) => `${f}="${h}"`).join(', ')}.`,
    `${report.debits} out, ${report.credits} in — ${report.signConvention}.`,
  ];
  if (report.duplicateGroups.length > 0) {
    const total = report.duplicateGroups.reduce((sum, group) => sum + group.count, 0);
    lines.push(`${total} rows share ${report.duplicateGroups.length} identical date/vendor/amount fingerprints — kept as separate charges; check the export was not run twice.`);
  }
  if (report.skipped.length > 0) {
    lines.push(`${report.skipped.length} rows skipped:`);
    for (const skip of report.skipped) {
      lines.push(`  - line ${skip.line}: ${skip.reason}${skip.text ? ` (${skip.text})` : ''}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  CsvError,
  parseCsv,
  parseCsvRows,
  sniffDelimiter,
  locateColumns,
  detectDateFormat,
  parseDate,
  importStatementCsv,
  summariseImport,
  slugDescription: (text) => slug(text, 'description', { maxLength: 60 }),
};
