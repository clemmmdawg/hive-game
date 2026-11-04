import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStaticPath } from '../server/static.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'assets', 'icons');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const EXPECTED = {
  'icon-192.png': 192,
  'icon-512.png': 512,
  'icon-maskable-512.png': 512,
  'apple-touch-icon-180.png': 180,
  'favicon-32.png': 32,
};

for (const [file, size] of Object.entries(EXPECTED)) {
  test(`${file} is a ${size}x${size} PNG`, async () => {
    const buf = await readFile(path.join(ICON_DIR, file));
    assert.ok(buf.subarray(0, 8).equals(PNG_SIGNATURE), 'PNG signature');
    assert.equal(buf.toString('ascii', 12, 16), 'IHDR');
    assert.equal(buf.readUInt32BE(16), size, 'width');
    assert.equal(buf.readUInt32BE(20), size, 'height');
  });
}

test('icon.svg is a static SVG file using the species-gold queen', async () => {
  const svg = await readFile(path.join(ICON_DIR, 'icon.svg'), 'utf8');
  assert.match(svg, /^<svg [^>]*viewBox="0 0 512 512"/);
  assert.ok(svg.includes('#ffd23f'), 'queen gold');
  assert.ok(svg.includes('#ff2d78') && svg.includes('#00f5ff'), 'magenta to cyan rim');
});

test('static server serves the icon directory', () => {
  assert.equal(resolveStaticPath('/srv/hive', '/assets/icons/icon-192.png'), '/srv/hive/assets/icons/icon-192.png');
});

test('index.html links the favicon and apple-touch-icon', async () => {
  const html = await readFile(path.join(ROOT, 'index.html'), 'utf8');
  assert.match(html, /<link rel="icon" type="image\/png" sizes="32x32" href="assets\/icons\/favicon-32\.png">/);
  assert.match(html, /<link rel="apple-touch-icon" href="assets\/icons\/apple-touch-icon-180\.png">/);
});

test('icon rim gradient passes through a vivid violet, not grey-lavender', async () => {
  const svg = await readFile(path.join(ICON_DIR, 'icon.svg'), 'utf8');
  const stops = [...svg.matchAll(/<linearGradient id="rim"[^]*?<\/linearGradient>/g)][0][0];
  assert.match(stops, /offset="0\.5" stop-color="#b36bff"/);
});

test('generated SVG has no float noise in numbers', async () => {
  const svg = await readFile(path.join(ICON_DIR, 'icon.svg'), 'utf8');
  assert.doesNotMatch(svg, /\d\.\d{4,}/);
});

test('favicon-32 is transparent outside the hex', async () => {
  const { inflateSync } = await import('node:zlib');
  const buf = await readFile(path.join(ICON_DIR, 'favicon-32.png'));
  assert.equal(buf[25], 6, 'RGBA colour type');
  const idat = [];
  for (let at = 8; at < buf.length;) {
    const len = buf.readUInt32BE(at), type = buf.toString('ascii', at + 4, at + 8);
    if (type === 'IDAT') idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  // Row 0 has no prior row, so its first pixel is stored raw whatever the filter: alpha is byte 4.
  assert.equal(raw[1 + 3], 0, 'top-left corner alpha');
});
