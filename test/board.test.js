import test from 'node:test';
import assert from 'node:assert/strict';

import { Board, stackLayers } from '../js/board.js';
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
