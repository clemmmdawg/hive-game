// sw-hash.mjs — Content hash of everything sw.js precaches, recorded in sw-manifest.json next to the
// CACHE name. test/pwa.test.js fails when the files drift from the record without a CACHE bump.
//   node scripts/sw-hash.mjs   -> stamp: refuses until CACHE has been bumped if the precached files changed.

import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function readSw() {
  const src = await readFile(path.join(ROOT, 'sw.js'), 'utf8');
  const cache = /const CACHE = '([^']+)'/.exec(src)?.[1];
  const body = /const PRECACHE = \[([\s\S]*?)\];/.exec(src)?.[1] ?? '';
  const files = [...body.matchAll(/'([^']+)'/g)].map(m => m[1]);
  return { cache, files };
}

/** sha256 over every precached file (path + bytes), '/' being index.html, in sorted order. */
export async function precacheHash(files) {
  const h = createHash('sha256');
  for (const url of [...new Set(files)].sort()) {
    const rel = url === '/' ? 'index.html' : url.slice(1);
    h.update(url + '\0').update(await readFile(path.join(ROOT, rel))).update('\0');
  }
  return h.digest('hex');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifestPath = path.join(ROOT, 'sw-manifest.json');
  const { cache, files } = await readSw();
  const hash = await precacheHash(files);
  let prev = null;
  try { prev = JSON.parse(await readFile(manifestPath, 'utf8')); } catch {}
  if (prev && prev.hash !== hash && prev.cache === cache) {
    console.error(`Precached files changed but CACHE is still '${cache}'. Bump CACHE in sw.js, then re-run.`);
    process.exit(1);
  }
  await writeFile(manifestPath, JSON.stringify({ cache, hash }, null, 2) + '\n');
  console.log(`sw-manifest.json: ${cache} ${hash.slice(0, 12)}`);
}
