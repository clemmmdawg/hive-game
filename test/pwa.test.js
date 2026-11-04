import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveStaticPath } from '../server/static.js';
import { readSw, precacheHash } from '../scripts/sw-hash.mjs';

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

/** Relative `.js` import specifiers, single- or double-quoted: static, dynamic and side-effect imports. */
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|import\s+)(['"])(\.[^'"]+\.js)\1/g;

test('the import scan sees single- and double-quoted specifiers', () => {
  const src = `import { a } from './a.js';\nimport { b } from "./b.js";\nimport "./c.js";\nawait import('./d.js');`;
  assert.deepEqual([...src.matchAll(IMPORT_RE)].map(m => m[2]), ['./a.js', './b.js', './c.js', './d.js']);
});

test('every module reachable from index.html is precached, and every precached file exists', async () => {
  const list = await precacheList();
  const seen = new Set();
  const walk = async rel => {
    if (seen.has(rel)) return;
    seen.add(rel);
    const src = await read(rel);
    for (const m of src.matchAll(IMPORT_RE)) {
      await walk(path.posix.join(path.posix.dirname(rel), m[2]));
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

test('hidden win, confirm and rules overlays start inert so their buttons leave the tab order', async () => {
  const html = await read('index.html');
  for (const id of ['win-screen', 'resign-confirm', 'rules-overlay']) {
    assert.match(html, new RegExp(`<div id="${id}"[^>]*\\binert\\b`), id);
  }
});

const FONT = '/assets/fonts/press-start-2p-latin.woff2';

test('the pixel font is self-hosted, precached and licensed (works offline after one visit)', async () => {
  const [html, css, sw] = await Promise.all([read('index.html'), read('styles.css'), read('sw.js')]);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)\.com/, 'no third-party font request');
  assert.doesNotMatch(sw, /fonts\.(googleapis|gstatic)\.com/, 'no font runtime-cache branch left');
  const face = /@font-face\s*{([^}]*)}/.exec(css)?.[1] ?? '';
  assert.match(face, /font-family:\s*'Press Start 2P'/);
  assert.match(face, /font-display:\s*swap/);
  assert.ok(face.includes(`url('${FONT.slice(1)}')`), 'styles.css @font-face points at the local woff2');
  assert.ok((await precacheList()).includes(FONT), 'font precached');
  await access(path.join(ROOT, FONT));
  assert.match(await read('assets/fonts/OFL.txt'), /SIL OPEN FONT LICENSE Version 1\.1/);
});

/** The z-index of the first rule whose selector is exactly `selector`. */
function zIndexOf(css, selector) {
  const esc = selector.replace(/[#.]/g, c => `\\${c}`);
  const body = new RegExp(`^${esc}\\s*{([^}]*)}`, 'm').exec(css)?.[1];
  return Number(/z-index:\s*(\d+)/.exec(body ?? '')?.[1]);
}

test('toasts stack above the menu, win, confirm and rules layers (the update RELOAD must be tappable)', async () => {
  const css = await read('styles.css');
  const toastZ = zIndexOf(css, '#toast');
  for (const layer of ['#menu-screen', '#win-screen', '#resign-confirm', '#rules-overlay', '#moves-sheet']) {
    const z = zIndexOf(css, layer);
    assert.ok(Number.isFinite(z), `${layer} has a z-index`);
    assert.ok(toastZ > z, `#toast (${toastZ}) above ${layer} (${z})`);
  }
  assert.match(/^#toast\s*{([^}]*)}/m.exec(css)[1], /pointer-events:\s*none/, 'the toast pill never blocks taps');
  assert.doesNotMatch(/^#toast\.has-action\s*{([^}]*)}/m.exec(css)?.[1] ?? '', /pointer-events/, 'not even with an action');
  assert.match(/^#toast\.has-action \.toast-action\s*{([^}]*)}/m.exec(css)?.[1] ?? '', /pointer-events:\s*auto/, 'only its button');
});

test('precached files only change together with a CACHE bump (sw-manifest.json)', async () => {
  const { cache, files } = await readSw();
  const rec = JSON.parse(await read('sw-manifest.json'));
  const hash = await precacheHash(files);
  assert.ok(
    rec.hash === hash,
    'A precached file changed: bump CACHE in sw.js, then run `npm run sw:stamp` to record the new hash.',
  );
  assert.equal(rec.cache, cache, 'sw.js CACHE differs from sw-manifest.json: run `npm run sw:stamp`.');
});
