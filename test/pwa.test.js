import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStaticPath } from '../server/static.js';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => readFile(path.join(ROOT, rel), 'utf8');

test('static allowlist serves the PWA files and still rejects server code', () => {
  for (const url of ['/manifest.json', '/sw.js', '/assets/icons/icon-192.png', '/?room=ABCD']) {
    assert.ok(resolveStaticPath(ROOT, url), url);
  }
  assert.equal(resolveStaticPath(ROOT, '/server/server.js'), null);
});

test('manifest declares an installable standalone app with 192/512/maskable icons', async () => {
  const m = JSON.parse(await read('manifest.json'));
  assert.equal(m.display, 'standalone');
  assert.equal(m.theme_color, '#05050f');
  assert.equal(m.background_color, '#05050f');
  assert.ok(m.name && m.short_name && m.start_url && m.scope);
  const sizes = m.icons.map(i => `${i.sizes}:${i.purpose ?? 'any'}`);
  for (const want of ['192x192:any', '512x512:any', '512x512:maskable']) assert.ok(sizes.includes(want), want);
  for (const icon of m.icons) await access(path.join(ROOT, icon.src));
});

test('index.html links the manifest and keeps the theme colour in step with it', async () => {
  const html = await read('index.html');
  assert.match(html, /<link rel="manifest" href="manifest\.json">/);
  assert.match(html, /<meta name="theme-color" content="#05050f">/);
  assert.match(html, /apple-mobile-web-app-capable/);
});

/** The quoted paths inside `const PRECACHE = [ ... ]` in sw.js. */
async function precacheList() {
  const src = await read('sw.js');
  const body = /const PRECACHE = \[([\s\S]*?)\];/.exec(src)?.[1];
  assert.ok(body, 'sw.js declares PRECACHE');
  return [...body.matchAll(/'([^']+)'/g)].map(m => m[1]);
}

test('every module reachable from index.html is precached, and every precached file exists', async () => {
  const list = await precacheList();
  const seen = new Set();
  const walk = async rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = await read(rel);
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)'(\.[^']+\.js)'/g)) {
      await walk(path.posix.join(path.posix.dirname(rel), m[1]));
    }
  };
  const html = await read('index.html');
  for (const m of html.matchAll(/<script[^>]+src="([^"]+)"/g)) await walk(m[1]);
  assert.ok(seen.size > 5);
  for (const rel of seen) assert.ok(list.includes('/' + rel), `${rel} missing from PRECACHE`);
  for (const p of list) {
    if (p !== '/') await access(path.join(ROOT, p));
  }
  for (const needed of ['/', '/index.html', '/styles.css', '/manifest.json', '/assets/icons/icon-192.png']) {
    assert.ok(list.includes(needed), needed);
  }
});

test('sw.js has a versioned cache, SKIP_WAITING handling and ignores non-GET and /ws', async () => {
  const src = await read('sw.js');
  assert.match(src, /const CACHE = 'hive-v\d+'/);
  assert.match(src, /SKIP_WAITING/);
  assert.match(src, /request\.method !== 'GET'/);
  assert.match(src, /\/ws/);
});

test('hidden win and confirm overlays start inert so their buttons leave the tab order', async () => {
  const html = await read('index.html');
  for (const id of ['win-screen', 'resign-confirm']) {
    assert.match(html, new RegExp(`<div id="${id}"[^>]*\\binert\\b`), id);
  }
});
