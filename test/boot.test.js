import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

/** Spawn `node <entry> <port>`, resolve once it prints the listening line, then kill it. */
async function bootsAndListens(entry) {
  const port = await freePort();
  const child = spawn(process.execPath, [entry, String(port)], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no listening line; output: ${out}`)), 8000);
      child.stdout.on('data', d => {
        out += d;
        if (/listening on http:\/\/localhost:\d+/.test(out)) { clearTimeout(timer); resolve(out); }
      });
      child.on('exit', code => { clearTimeout(timer); reject(new Error(`exited ${code} before listening; output: ${out}`)); });
    });
  } finally {
    child.removeAllListeners('exit');
    child.kill();
  }
}

test('server/index.js listens', async () => {
  assert.match(await bootsAndListens(path.join(ROOT, 'server/index.js')), /listening/);
});

test('server/index.js listens when reached through a symlinked checkout', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'hive-link-'));
  try {
    const link = path.join(dir, 'current');
    await symlink(ROOT, link);
    assert.match(await bootsAndListens(path.join(link, 'server/index.js')), /listening/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('importing server.js does not start a server', async () => {
  const child = spawn(process.execPath, ['-e', "import('./server/server.js').then(m => { console.log(typeof m.createHiveServer); })"], { cwd: ROOT });
  let out = '';
  child.stdout.on('data', d => { out += d; });
  const code = await new Promise(r => child.on('exit', r));
  assert.equal(code, 0);
  assert.equal(out.trim(), 'function');
});
