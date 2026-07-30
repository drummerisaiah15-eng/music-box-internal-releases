'use strict';

const fs = require('fs');
const path = require('path');

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_SHEETS = 25;
const MAX_ROWS = 500;
const MAX_COLS = 100;
const MAX_GRID_CELLS = 10000;
const MAX_TOTAL_GRID_CELLS = 50000;
const MAX_NON_EMPTY_CELLS = 10000;
const MAX_TOTAL_CHARS = 400000;
const MAX_CELL_CHARS = 50000;
const MAX_RESULT_BYTES = 700000;

function boundedCellText(value) {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  if (text.length > MAX_CELL_CHARS) {
    throw new Error('A spreadsheet cell exceeds the 50,000-character limit.');
  }
  return text;
}

function validateRows(rows, totals) {
  if (!Array.isArray(rows) || rows.length > MAX_ROWS) {
    throw new Error(`Spreadsheet sheets may contain at most ${MAX_ROWS} rows.`);
  }
  let maxCols = 0;
  const normalized = rows.map(row => {
    if (!Array.isArray(row) || row.length > MAX_COLS) {
      throw new Error(`Spreadsheet sheets may contain at most ${MAX_COLS} columns.`);
    }
    maxCols = Math.max(maxCols, row.length);
    return row.map(value => {
      const text = boundedCellText(value);
      if (text !== '') {
        totals.nonEmpty += 1;
        totals.characters += text.length;
        if (totals.nonEmpty > MAX_NON_EMPTY_CELLS) {
          throw new Error('The spreadsheet contains too many non-empty cells.');
        }
        if (totals.characters > MAX_TOTAL_CHARS) {
          throw new Error('The spreadsheet contains too much text.');
        }
      }
      return text;
    });
  });
  const gridCells = normalized.length * maxCols;
  if (gridCells > MAX_GRID_CELLS) {
    throw new Error('A spreadsheet sheet has unsafe dimensions.');
  }
  totals.gridCells += gridCells;
  if (totals.gridCells > MAX_TOTAL_GRID_CELLS) {
    throw new Error('The spreadsheet contains too many total grid cells.');
  }
  while (normalized.length && normalized[normalized.length - 1].every(value => value === '')) {
    normalized.pop();
  }
  return normalized;
}

function parseCsv(text) {
  if (typeof text !== 'string') throw new Error('The CSV text is invalid.');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;

  const pushCell = () => {
    row.push(cell);
    if (row.length > MAX_COLS) {
      throw new Error(`CSV files may contain at most ${MAX_COLS} columns.`);
    }
    cell = '';
    afterQuote = false;
  };
  const pushRow = () => {
    pushCell();
    rows.push(row);
    if (rows.length > MAX_ROWS) {
      throw new Error(`CSV files may contain at most ${MAX_ROWS} rows.`);
    }
    row = [];
  };

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      if (cell.length > MAX_CELL_CHARS) {
        throw new Error('A CSV cell exceeds the 50,000-character limit.');
      }
    } else if (afterQuote) {
      if (character === ',') pushCell();
      else if (character === '\n') pushRow();
      else if (character === '\r') {
        if (text[index + 1] === '\n') index += 1;
        pushRow();
      } else if (character !== ' ' && character !== '\t') {
        throw new Error('The CSV contains unexpected text after a closing quote.');
      }
    } else if (character === '"' && cell === '') {
      quoted = true;
    } else if (character === ',') {
      pushCell();
    } else if (character === '\n') {
      pushRow();
    } else if (character === '\r') {
      if (text[index + 1] === '\n') index += 1;
      pushRow();
    } else {
      cell += character;
      if (cell.length > MAX_CELL_CHARS) {
        throw new Error('A CSV cell exceeds the 50,000-character limit.');
      }
    }
  }
  if (quoted) throw new Error('The CSV ends inside a quoted field.');
  if (cell !== '' || row.length || text.endsWith(',')) pushRow();
  while (rows.length && rows[rows.length - 1].every(value => value === '')) rows.pop();
  return rows;
}

function validateWorksheetRange(XLSX, worksheet, totals) {
  const ref = worksheet?.['!ref'];
  if (ref !== undefined) {
    if (typeof ref !== 'string' || ref.length > 64) {
      throw new Error('The workbook contains an invalid worksheet range.');
    }
    const range = XLSX.utils.decode_range(ref);
    const rows = range.e.r - range.s.r + 1;
    const cols = range.e.c - range.s.c + 1;
    if (!Number.isSafeInteger(rows) || rows < 1 || rows > MAX_ROWS ||
        !Number.isSafeInteger(cols) || cols < 1 || cols > MAX_COLS ||
        rows * cols > MAX_GRID_CELLS) {
      throw new Error('The workbook declares unsafe worksheet dimensions.');
    }
  }

  let worksheetCells = 0;
  for (const key of Object.keys(worksheet || {})) {
    if (key.startsWith('!')) continue;
    if (!/^[A-Z]{1,3}[1-9]\d*$/.test(key)) {
      throw new Error('The workbook contains an invalid cell address.');
    }
    const address = XLSX.utils.decode_cell(key);
    if (address.r >= MAX_ROWS || address.c >= MAX_COLS) {
      throw new Error('The workbook contains a cell outside the safe worksheet dimensions.');
    }
    worksheetCells += 1;
    totals.rawCells += 1;
    if (worksheetCells > MAX_GRID_CELLS || totals.rawCells > MAX_NON_EMPTY_CELLS) {
      throw new Error('The workbook contains too many populated cells.');
    }
  }
}

function parseWorkbook(buffer, XLSX) {
  const workbook = XLSX.read(buffer, {
    type: 'buffer',
    dense: false,
    cellFormula: false,
    cellHTML: false,
    cellNF: false,
    cellStyles: false,
    bookVBA: false,
    bookDeps: false,
    bookFiles: false,
  });
  if (!Array.isArray(workbook?.SheetNames) ||
      workbook.SheetNames.length < 1 || workbook.SheetNames.length > MAX_SHEETS) {
    throw new Error(`Workbooks must contain between 1 and ${MAX_SHEETS} sheets.`);
  }
  const totals = { nonEmpty: 0, characters: 0, gridCells: 0, rawCells: 0 };
  return workbook.SheetNames.map(sheetNameValue => {
    const sheetName = String(sheetNameValue || '').trim();
    if (!sheetName || sheetName.length > 160) {
      throw new Error('The workbook contains an invalid sheet name.');
    }
    const worksheet = workbook.Sheets[sheetNameValue];
    if (!worksheet || typeof worksheet !== 'object') {
      throw new Error('The workbook contains a missing worksheet.');
    }
    validateWorksheetRange(XLSX, worksheet, totals);
    const rows = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: '',
      blankrows: true,
      raw: false,
    });
    return { sheetName, rows: validateRows(rows, totals) };
  });
}

async function parseSpreadsheetFile(filePath, vendorPath) {
  if (typeof filePath !== 'string' || typeof vendorPath !== 'string') {
    throw new Error('Invalid spreadsheet input.');
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!['.csv', '.xlsx', '.xls'].includes(extension)) {
    throw new Error('Choose a CSV, XLSX, or XLS spreadsheet.');
  }
  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > MAX_SOURCE_BYTES) {
      throw new Error('The spreadsheet is empty or exceeds the 5 MB import limit.');
    }
    const buffer = await handle.readFile();
    let sheets;
    if (extension === '.csv') {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const text = decoder.decode(buffer);
      const totals = { nonEmpty: 0, characters: 0, gridCells: 0, rawCells: 0 };
      sheets = [{ sheetName: 'Sheet 1', rows: validateRows(parseCsv(text), totals) }];
    } else {
      const resolvedVendor = await fs.promises.realpath(vendorPath);
      const expectedSuffix = path.join('sheetjs-0.20.3', 'xlsx.full.min.js');
      if (!resolvedVendor.endsWith(expectedSuffix)) {
        throw new Error('The trusted spreadsheet parser is unavailable.');
      }
      const XLSX = require(resolvedVendor);
      if (!XLSX?.read || !XLSX?.utils?.sheet_to_json) {
        throw new Error('The trusted spreadsheet parser is invalid.');
      }
      sheets = parseWorkbook(buffer, XLSX);
    }
    const result = { sheets };
    if (Buffer.byteLength(JSON.stringify(result), 'utf8') > MAX_RESULT_BYTES) {
      throw new Error('The parsed spreadsheet exceeds the safe import result limit.');
    }
    return result;
  } finally {
    await handle.close();
  }
}

if (process.parentPort) {
  let handled = false;
  process.parentPort.on('message', async event => {
    if (handled) return;
    handled = true;
    try {
      const request = event?.data;
      const result = await parseSpreadsheetFile(request?.filePath, request?.vendorPath);
      process.parentPort.postMessage({ ok: true, sheets: result.sheets });
    } catch (error) {
      process.parentPort.postMessage({
        ok: false,
        error: String(error?.message || 'Spreadsheet import failed.').slice(0, 500),
      });
    }
  });
}

module.exports = {
  parseCsv,
  parseSpreadsheetFile,
  validateWorksheetRange,
  validateRows,
};
