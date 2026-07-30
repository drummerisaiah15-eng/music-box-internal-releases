'use strict';

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const MAX_PDF_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_BYTES = 4 * 1024 * 1024;
const MAX_PAGES = 500;

async function parsePdfFile(filePath, maxTextBytes = MAX_TEXT_BYTES) {
  if (typeof filePath !== 'string' || path.extname(filePath).toLowerCase() !== '.pdf') {
    throw new Error('Invalid PDF input.');
  }
  if (!Number.isSafeInteger(maxTextBytes) || maxTextBytes < 1 || maxTextBytes > MAX_TEXT_BYTES) {
    throw new Error('Invalid PDF output limit.');
  }

  const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
  const handle = await fs.promises.open(filePath, fs.constants.O_RDONLY | noFollow);
  let parser = null;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 5 || stat.size > MAX_PDF_BYTES) {
      throw new Error('The PDF is empty or exceeds the 20 MB limit.');
    }
    const buffer = await handle.readFile();
    if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
      throw new Error('The selected file is not a valid PDF.');
    }

    parser = new PDFParse({
      data: new Uint8Array(buffer),
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false,
    });
    const info = await parser.getInfo();
    if (!Number.isSafeInteger(info.total) || info.total < 1 || info.total > MAX_PAGES) {
      throw new Error(`PDFs must contain between 1 and ${MAX_PAGES} pages.`);
    }
    const result = await parser.getText({ first: info.total, pageJoiner: '' });
    const text = typeof result?.text === 'string' ? result.text : '';
    if (Buffer.byteLength(text, 'utf8') > maxTextBytes) {
      throw new Error('Extracted PDF text exceeds the 4 MB limit.');
    }
    return { text, pages: info.total };
  } finally {
    if (parser) {
      try { await parser.destroy(); } catch (_) {}
    }
    await handle.close();
  }
}

if (process.parentPort) {
  let handled = false;
  process.parentPort.on('message', async (event) => {
    if (handled) return;
    handled = true;
    try {
      const request = event?.data;
      const result = await parsePdfFile(request?.filePath, request?.maxTextBytes);
      process.parentPort.postMessage({ ok: true, text: result.text, pages: result.pages });
    } catch (error) {
      process.parentPort.postMessage({
        ok: false,
        error: String(error?.message || 'PDF extraction failed.').slice(0, 500),
      });
    }
  });
}

module.exports = { parsePdfFile };
