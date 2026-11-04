import test from 'node:test';
import assert from 'node:assert/strict';

import { Board } from '../js/board.js';
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
