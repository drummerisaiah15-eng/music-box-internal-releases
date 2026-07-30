const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const XLSX = require('xlsx');

const {
  parseCsv,
  parseSpreadsheetFile,
  validateWorksheetRange,
} = require('../spreadsheet-worker');

const vendorPath = path.join(
  __dirname,
  '..',
  'vendor',
  'sheetjs-0.20.3',
  'xlsx.full.min.js'
);

test('CSV parser preserves quoted newlines and escaped quotes', () => {
  assert.deepEqual(
    parseCsv('Name,Notes\r\nAna,\"Line one\nLine two\"\r\nEmma,\"She said \"\"yes\"\"\"'),
    [
      ['Name', 'Notes'],
      ['Ana', 'Line one\nLine two'],
      ['Emma', 'She said "yes"'],
    ]
  );
  assert.throws(() => parseCsv('Name,\"unfinished'), /inside a quoted field/);
});

test('spreadsheet worker parses CSV and XLSX through bounded file inputs', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-spreadsheet-worker-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const csvPath = path.join(tempDir, 'schedule.csv');
  fs.writeFileSync(csvPath, 'Name,Notes\nAna,\"Monday\nTuesday\"\n');
  const csv = await parseSpreadsheetFile(csvPath, vendorPath);
  assert.deepEqual(csv.sheets[0].rows, [
    ['Name', 'Notes'],
    ['Ana', 'Monday\nTuesday'],
  ]);

  const xlsxPath = path.join(tempDir, 'schedule.xlsx');
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([['Instructor', 'Room'], ['Emma', 'A']]),
    'Fall'
  );
  XLSX.writeFile(workbook, xlsxPath);
  const xlsx = await parseSpreadsheetFile(xlsxPath, vendorPath);
  assert.deepEqual(xlsx.sheets, [{
    sheetName: 'Fall',
    rows: [['Instructor', 'Room'], ['Emma', 'A']],
  }]);
});

test('spreadsheet worker rejects unsafe declared ranges before row expansion', () => {
  assert.throws(
    () => validateWorksheetRange(
      XLSX,
      { '!ref': 'A1:XFD1048576', A1: { t: 's', v: 'safe cell' } },
      { rawCells: 0 }
    ),
    /unsafe worksheet dimensions/
  );
});

test('spreadsheet worker rejects oversized and invalid UTF-8 files', async t => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-spreadsheet-limits-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const oversized = path.join(tempDir, 'large.csv');
  const handle = fs.openSync(oversized, 'w');
  fs.ftruncateSync(handle, 5 * 1024 * 1024 + 1);
  fs.closeSync(handle);
  await assert.rejects(parseSpreadsheetFile(oversized, vendorPath), /exceeds the 5 MB/);

  const invalid = path.join(tempDir, 'invalid.csv');
  fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe, 0xfd]));
  await assert.rejects(parseSpreadsheetFile(invalid, vendorPath));
});
