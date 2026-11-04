import test from 'node:test';
import assert from 'node:assert/strict';

import { Board, stackLayers, hiveLayerKey, hiveBounds, layerCovers, badgeLayout } from '../js/board.js';
import { hexToPixel } from '../js/hex.js';

// Just enough of a <canvas> for Board's constructor and input wiring.
function fakeCanvas() {
  const listeners = {};
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (() => {}), set: (target, key, v) => { target[key] = v; return true; } });
  return {
    width: 0, height: 0, style: {},
    getContext: () => ctx,
    addEventListener: (type, fn) => { listeners[type] = fn; },
    setPointerCapture() {},
    fire(type, init) { listeners[type]({ preventDefault() {}, pointerType: 'touch', ...init }); },
  };
}

function makeBoard() {
  const canvas = fakeCanvas();
  const board = new Board(canvas, fakeCanvas());
  board.resize(400, 800);
  return { board, canvas };
}

test('a single clean tap fires onTap once', () => {
  const { board, canvas } = makeBoard();
  const taps = [];
  board.onTap = (q, r) => taps.push([q, r]);
  canvas.fire('pointerdown', { pointerId: 1, clientX: 200, clientY: 400 });
  canvas.fire('pointerup',   { pointerId: 1, clientX: 200, clientY: 400 });
  assert.equal(taps.length, 1);
});

test('lifting the fingers after a pinch does not fire a tap', () => {
  const { board, canvas } = makeBoard();
  const taps = [];
  board.onTap = (q, r) => taps.push([q, r]);
  canvas.fire('pointerdown', { pointerId: 1, clientX: 150, clientY: 400 });
  canvas.fire('pointerdown', { pointerId: 2, clientX: 250, clientY: 400 });
  canvas.fire('pointermove', { pointerId: 2, clientX: 300, clientY: 400 });
  canvas.fire('pointerup',   { pointerId: 1, clientX: 150, clientY: 400 });
  canvas.fire('pointerup',   { pointerId: 2, clientX: 300, clientY: 400 });
  assert.deepEqual(taps, []);
});

test('recenter fits the whole hive between the HUD and the tray', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  const keys = ['-6,0', '6,0', '0,-5', '0,5', '3,2'];
  for (const k of keys) board.pieces.set(k, [{ player: 1, type: 'ANT', emoji: '🐜' }]);
  board.recenter(false);

  for (const k of keys) {
    const [q, r] = k.split(',').map(Number);
    const p = hexToPixel(q, r, board.SIZE);
    const sx = board.tx + p.x * board.scale;
    const sy = board.ty + p.y * board.scale;
    assert.ok(sx - board.SIZE * board.scale >= 0 && sx + board.SIZE * board.scale <= 400, `${k} x in view`);
    assert.ok(sy - board.SIZE * board.scale >= 52 && sy + board.SIZE * board.scale <= 800 - 112, `${k} y in view`);
  }
});

test('recenter on an empty board centers the origin in the playable area', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  board.scale = 2.5; board.tx = -300; board.ty = 999;
  board.recenter(false);
  assert.equal(board.scale, 1);
  assert.equal(board.tx, 200);
  assert.equal(board.ty, 52 + (800 - 52 - 112) / 2);
});

test('stackLayers: a lone tile sits flat at full size', () => {
  const layers = stackLayers(1, 40);
  assert.equal(layers.length, 1);
  assert.equal(layers[0].dx, 0);
  assert.equal(layers[0].dy, 0);
  assert.equal(layers[0].scale, 1);
  assert.equal(layers[0].shade, 0);
});

test('stackLayers: a stack rises in steps, top tile stays large and unshaded', () => {
  for (const height of [2, 3, 5, 7]) {
    const layers = stackLayers(height, 40);
    assert.equal(layers.length, height);
    for (let i = 1; i < height; i++) {
      assert.ok(layers[i].dy < layers[i - 1].dy, `layer ${i} of ${height} rises`);
      assert.ok(layers[i].scale <= layers[i - 1].scale, `layer ${i} of ${height} is not larger than the one below`);
      assert.ok(layers[i].shade < layers[i - 1].shade, `layer ${i} of ${height} is lighter than the one below`);
    }
    const top = layers[height - 1];
    assert.ok(top.scale >= 0.8, `top scale ${top.scale} of ${height}`);
    assert.equal(top.shade, 0);
    // The whole stack stays within ~a third of a hex of its cell, whatever its height.
    assert.ok(layers[0].dy - top.dy <= 40 * 0.32, `rise of ${height}-stack`);
  }
});

test('stackLayers scales with the tile size', () => {
  const small = stackLayers(3, 20), big = stackLayers(3, 40);
  for (let i = 0; i < 3; i++) {
    assert.equal(big[i].dy, small[i].dy * 2);
    assert.equal(big[i].scale, small[i].scale);
  }
});


// ── Hive layer cache helpers ─────────────────────────────

function layerInputs(over = {}) {
  return {
    pieces: new Map([['0,0', [{ player: 1, type: 'QUEEN' }]], ['1,0', [{ player: 2, type: 'ANT' }, { player: 1, type: 'BEETLE' }]]]),
    ghosts: new Set(['2,0', '-1,0']),
    throwTargets: new Set(),
    selectedHex: null,
    throwPick: null,
    lastMove: { from: '2,-1', to: '1,0', player: 1 },
    hiddenTop: new Set(),
    hiddenStacks: new Set(),
    ...over,
  };
}

test('hiveLayerKey: equal content in fresh Map/Set instances gives the same key', () => {
  assert.equal(hiveLayerKey(layerInputs()), hiveLayerKey(layerInputs()));
});

test('hiveLayerKey: changes whenever something the layer draws changes', () => {
  const base = hiveLayerKey(layerInputs());
  const variants = {
    'piece added':      layerInputs({ pieces: new Map([...layerInputs().pieces, ['0,1', [{ player: 2, type: 'SPIDER' }]]]) }),
    'stack grew':       layerInputs({ pieces: new Map([['0,0', [{ player: 1, type: 'QUEEN' }, { player: 2, type: 'BEETLE' }]], ['1,0', layerInputs().pieces.get('1,0')]]) }),
    'owner changed':    layerInputs({ pieces: new Map([['0,0', [{ player: 2, type: 'QUEEN' }]], ['1,0', layerInputs().pieces.get('1,0')]]) }),
    'ghosts':           layerInputs({ ghosts: new Set(['2,0']) }),
    'selection':        layerInputs({ selectedHex: '0,0' }),
    'throw pick':       layerInputs({ throwPick: '0,0' }),
    'last move':        layerInputs({ lastMove: { from: null, to: '1,0', player: 1 } }),
    'no last move':     layerInputs({ lastMove: null }),
    'hidden top':       layerInputs({ hiddenTop: new Set(['1,0']) }),
    'hidden stack':     layerInputs({ hiddenStacks: new Set(['0,0']) }),
    'png art loaded':   layerInputs({ pieces: new Map([['0,0', [{ player: 1, type: 'QUEEN', image: {} }]], ['1,0', layerInputs().pieces.get('1,0')]]) }),
  };
  for (const [what, inputs] of Object.entries(variants)) assert.notEqual(hiveLayerKey(inputs), base, what);
});

test('hiveLayerKey: sees pieces mutated in place (app.js clears and refills the same Map)', () => {
  const inputs = layerInputs();
  const before = hiveLayerKey(inputs);
  inputs.pieces.get('0,0').push({ player: 2, type: 'BEETLE' });
  assert.notEqual(hiveLayerKey(inputs), before);
});

test('hiveLayerKey: throw targets alone do not dirty the layer (they are drawn live)', () => {
  assert.equal(hiveLayerKey(layerInputs({ throwTargets: new Set(['0,0']) })), hiveLayerKey(layerInputs()));
});

test('hiveBounds: null when empty, padded box around every hex otherwise', () => {
  assert.equal(hiveBounds([], 50, 10), null);
  const b = hiveBounds(['0,0', '2,0'], 50, 10);
  const far = hexToPixel(2, 0, 50);
  assert.equal(b.x0, -10);
  assert.equal(b.y0, -10);
  assert.equal(b.x1, far.x + 10);
  assert.equal(b.y1, far.y + 10);
});

test('layerCovers: the visible part of the hive must lie inside the cached layer', () => {
  const layer   = { x0: 0, y0: 0, x1: 100, y1: 100 };
  const content = { x0: 10, y0: 10, x1: 300, y1: 90 };
  assert.equal(layerCovers(layer, { x0: 0, y0: 0, x1: 100, y1: 100 }, content), true);
  assert.equal(layerCovers(layer, { x0: 50, y0: 0, x1: 150, y1: 100 }, content), false, 'panned onto uncached hive');
  assert.equal(layerCovers(layer, { x0: 500, y0: 0, x1: 600, y1: 100 }, content), true, 'hive entirely off-screen');
  assert.equal(layerCovers(layer, { x0: 0, y0: 0, x1: 100, y1: 100 }, null), true, 'empty board');
});

test('badgeLayout: full badges scale with the tile; small tiles get a compact cue', () => {
  const big = badgeLayout(40), bigger = badgeLayout(80);
  assert.equal(big.mode, 'full');
  assert.equal(bigger.chipR, big.chipR * 2);
  assert.equal(badgeLayout(21).mode, 'compact');
  assert.equal(badgeLayout(14).mode, 'compact');
  assert.equal(badgeLayout(6).mode, 'none');
});

test('badgeLayout: badges never reach past the tile onto neighbours', () => {
  for (const r of [10, 14, 18, 21, 22, 28, 40, 80]) {
    const b = badgeLayout(r);
    assert.ok(b.chipDist + b.chipR <= r * 0.95, `chips inside the tile at r=${r}`);
  }
});

test('badgeLayout: the compact cue covers at most ~15% of the top glyph', () => {
  for (const r of [10, 14, 18, 21]) {
    const b = badgeLayout(r);
    // Monte Carlo the overlap of the cue disc with the glyph's art box (78% of GLYPH_BOX·r).
    const half = r * 1.34 * 0.78 / 2;
    const cx = b.chipDist * Math.cos(b.angle), cy = b.chipDist * Math.sin(b.angle);
    let inBox = 0, covered = 0;
    for (let i = 0; i < 200; i++) for (let j = 0; j < 200; j++) {
      const x = -half + (2 * half) * (i + 0.5) / 200, y = -half + (2 * half) * (j + 0.5) / 200;
      inBox++;
      if (Math.hypot(x - cx, y - cy) <= b.chipR) covered++;
    }
    assert.ok(covered / inBox <= 0.15, `r=${r}: covers ${(100 * covered / inBox).toFixed(1)}%`);
  }
});
