// Off-screen target indicators: pure geometry (board.js offscreenTargets) + Board wiring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, offscreenTargets, OFFSCREEN_INSET } from '../js/board.js';

const RECT = { x0: 0, y0: 60, x1: 400, y1: 700 };
const pt = (key, x, y, kind = 'ghost') => ({ key, x, y, kind });

test('offscreenTargets: nothing when every target is inside the playable rect', () => {
  assert.deepEqual(offscreenTargets([pt('a', 10, 70), pt('b', 390, 690), pt('c', 200, 300)], RECT), []);
  assert.deepEqual(offscreenTargets([], RECT), []);
});

test('offscreenTargets: one chevron per edge, inside the rect, pointing at the targets', () => {
  const out = offscreenTargets([
    pt('up', 200, 20),        // under the HUD
    pt('right', 480, 400),
    pt('down', 150, 760),     // under the tray
    pt('left', -90, 380),
  ], RECT);
  const byEdge = Object.fromEntries(out.map(c => [c.edge, c]));
  assert.deepEqual(Object.keys(byEdge).sort(), ['bottom', 'left', 'right', 'top']);
  for (const c of out) {
    assert.equal(c.count, 1);
    assert.ok(c.x >= RECT.x0 + OFFSCREEN_INSET - 1e-9 && c.x <= RECT.x1 - OFFSCREEN_INSET + 1e-9, `${c.edge} x ${c.x}`);
    assert.ok(c.y >= RECT.y0 + OFFSCREEN_INSET - 1e-9 && c.y <= RECT.y1 - OFFSCREEN_INSET + 1e-9, `${c.edge} y ${c.y}`);
  }
  assert.equal(byEdge.top.y, RECT.y0 + OFFSCREEN_INSET);
  assert.equal(byEdge.top.x, 200, 'straight above: same x as the target');
  assert.equal(byEdge.bottom.y, RECT.y1 - OFFSCREEN_INSET);
  assert.equal(byEdge.right.x, RECT.x1 - OFFSCREEN_INSET);
  assert.equal(byEdge.left.x, RECT.x0 + OFFSCREEN_INSET);
  // angle points from the chevron toward its targets
  assert.ok(Math.abs(byEdge.right.angle) < 0.2);
  assert.ok(Math.abs(Math.abs(byEdge.left.angle) - Math.PI) < 0.2);
  assert.ok(Math.abs(byEdge.top.angle + Math.PI / 2) < 0.2);
  assert.ok(Math.abs(byEdge.bottom.angle - Math.PI / 2) < 0.3);
  assert.deepEqual(byEdge.up?.keys, undefined);
  assert.deepEqual(byEdge.top.keys, ['up']);
});

test('offscreenTargets: nearby targets on one edge cluster with a count; distant ones split', () => {
  const out = offscreenTargets([
    pt('r1', 460, 300), pt('r2', 470, 330), pt('r3', 520, 320), // one cluster
    pt('r4', 450, 640),                                          // far down the same edge
  ], RECT);
  assert.equal(out.length, 2);
  const [a, b] = out.sort((m, n) => m.y - n.y);
  assert.equal(a.edge, 'right');
  assert.equal(a.count, 3);
  assert.deepEqual([...a.keys].sort(), ['r1', 'r2', 'r3']);
  assert.equal(b.count, 1);
});

test('offscreenTargets: chevrons keep clear of the corners', () => {
  const [c] = offscreenTargets([pt('far', 900, 40)], RECT, { corner: 40 });
  assert.ok(c.y >= RECT.y0 + 40 - 1e-9, `y ${c.y}`);
  assert.ok(c.x <= RECT.x1 - OFFSCREEN_INSET + 1e-9);
});

test('offscreenTargets: kind is "throw" only when every target in the cluster is a throw', () => {
  assert.equal(offscreenTargets([pt('a', 500, 300, 'throw')], RECT)[0].kind, 'throw');
  assert.equal(offscreenTargets([pt('a', 500, 300, 'throw'), pt('b', 500, 320)], RECT)[0].kind, 'ghost');
});

// ── Board wiring ──

function fakeCanvas() {
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (() => stub), set: (target, key, v) => { target[key] = v; return true; } });
  return { width: 0, height: 0, style: {}, getContext: () => ctx, addEventListener() {}, setPointerCapture() {} };
}

function makeBoard() {
  const board = new Board(fakeCanvas(), fakeCanvas());
  board._makeCanvas = fakeCanvas;
  board.reducedMotion = true;
  board.resize(400, 800);
  board.insets = { top: 60, bottom: 100 };
  return board;
}

test('Board emits indicators for off-screen ghosts, only when they change, and never re-renders the layer for them', () => {
  const board = makeBoard();
  board.pieces.set('0,0', [{ player: 1, type: 'QUEEN', emoji: '' }]);
  board.recenter(false);
  const seen = [];
  board.onIndicators = list => seen.push(list);
  board.draw(0);
  assert.equal(seen.length, 0, 'no targets: nothing emitted');

  board.ghosts = new Set(['30,0']); // far off to the right
  board.draw(16);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 1);
  assert.equal(seen[0][0].edge, 'right');
  const layerId = board._layer.id;

  board.draw(32);
  board.draw(48);
  assert.equal(seen.length, 1, 'unchanged: not re-emitted');
  assert.equal(board._layer.id, layerId, 'the indicator overlay never re-renders the cached layer');

  board.ghosts = new Set();
  board.draw(64);
  assert.equal(seen.length, 2);
  assert.deepEqual(seen[1], []);
});

test('Board hides indicators while the camera animates', () => {
  const board = makeBoard();
  board.reducedMotion = false;
  board.pieces.set('0,0', [{ player: 1, type: 'QUEEN', emoji: '' }]);
  board.recenter(false);
  board.ghosts = new Set(['30,0']);
  let last = null;
  board.onIndicators = list => { last = list; };
  board.draw(0);
  assert.equal(last.length, 1);
  board.recenter(true); // camera now moving
  board.draw(16);
  assert.deepEqual(last, []);
});

test('showTargets pans (even right after a user pan) to bring the keys into view', () => {
  const board = makeBoard();
  board.pieces.set('0,0', [{ player: 1, type: 'QUEEN', emoji: '' }]);
  board.recenter(false);
  board._userCameraAt = performance.now(); // the user just panned: reveal() would hold off
  assert.equal(board.reveal(['30,0']), false);
  assert.equal(board.showTargets(['30,0']), true);
  const p = board.hexToScreen('30,0');
  assert.ok(p.x > 0 && p.x < 400, `x ${p.x}`);
  assert.ok(p.y > 60 && p.y < 700, `y ${p.y}`);
});

test('offscreenTargets: cornerBR keeps bottom and right chevrons clear of the bottom-right button', () => {
  const [b] = offscreenTargets([pt('b', 395, 760)], RECT, { cornerBR: 90 });
  assert.equal(b.edge, 'bottom');
  assert.ok(b.x <= RECT.x1 - 90 + 1e-9, `x ${b.x}`);
  const [r] = offscreenTargets([pt('r', 460, 690)], RECT, { cornerBR: 90 });
  assert.equal(r.edge, 'right');
  assert.ok(r.y <= RECT.y1 - 90 + 1e-9, `y ${r.y}`);
  const [l] = offscreenTargets([pt('l', -60, 690)], RECT, { cornerBR: 90 });
  assert.ok(l.y > RECT.y1 - 90, 'other corners unaffected');
});
