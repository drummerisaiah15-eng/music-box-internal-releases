const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parsePdfFile } = require('../pdf-worker');

function makeTextPdf(text) {
  const escaped = text.replace(/([\\()])/g, '\\$1');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${escaped.length + 34} >>\nstream\nBT /F1 18 Tf 72 720 Td (${escaped}) Tj ET\nendstream`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf, 'binary'));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'binary');
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'binary');
}

test('pdf worker extracts text through the supported pdf-parse v2 API', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-pdf-test-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const filePath = path.join(tempDir, 'receipt.pdf');
  fs.writeFileSync(filePath, makeTextPdf('Music Box PDF import works'));
  const result = await parsePdfFile(filePath);
  assert.equal(result.pages, 1);
  assert.match(result.text, /Music Box PDF import works/);
});

test('pdf worker rejects non-PDF bytes and oversized files before parsing', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'music-box-pdf-limits-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));

  const fakePath = path.join(tempDir, 'fake.pdf');
  fs.writeFileSync(fakePath, 'not really a pdf');
  await assert.rejects(parsePdfFile(fakePath), /not a valid PDF/);

  const largePath = path.join(tempDir, 'large.pdf');
  const handle = fs.openSync(largePath, 'w');
  fs.ftruncateSync(handle, 20 * 1024 * 1024 + 1);
  fs.closeSync(handle);
  await assert.rejects(parsePdfFile(largePath), /exceeds the 20 MB limit/);
});

test('dependency resolves to a PDF.js version newer than the CVE-2024-4367 fix', () => {
  const pdfParse = require('../node_modules/pdf-parse/package.json');
  const pdfjs = require('../node_modules/pdfjs-dist/package.json');
  assert.equal(pdfParse.version, '2.4.5');
  const [major, minor, patch] = pdfjs.version.split('.').map(Number);
  assert.ok(
    major > 4 || (major === 4 && (minor > 2 || (minor === 2 && patch >= 67))),
    `pdfjs-dist ${pdfjs.version} must be at least 4.2.67`
  );
});
