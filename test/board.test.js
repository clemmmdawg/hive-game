import test from 'node:test';
import assert from 'node:assert/strict';

import { Board, REVEAL_MIN_TILE_PX, stackLayers, hiveLayerKey, hiveBounds, layerCovers, badgeLayout, tweenPoint, moveDuration, LAND_MS, queenPips, winTiming, WIN_REVEAL_MAX_MS } from '../js/board.js';
import { hexToPixel } from '../js/hex.js';

// Just enough of a <canvas> for Board's constructor and input wiring.
function fakeCanvas() {
  const listeners = {};
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  const ctx = new Proxy({}, { get: (target, key) => target[key] ?? (() => stub), set: (target, key, v) => { target[key] = v; return true; } });
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
  board._makeCanvas = fakeCanvas;
  board.reducedMotion = false;
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


// ── Move animation ───────────────────────────────────────

const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const KINDS = ['slide', 'hop', 'climb', 'throw'];

test('tweenPoint: t=0 is the first point and t=1 the last, for every kind', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }];
  for (const kind of KINDS) {
    const a = tweenPoint(pts, 0, kind), b = tweenPoint(pts, 1, kind);
    assert.deepEqual([a.x, a.y], [0, 0], kind);
    assert.deepEqual([b.x, b.y], [10, 20], kind);
    assert.ok(near(a.lift, 0) && near(b.lift, 0), `${kind} lift is 0 at both ends`);
  }
  const drop = [{ x: 4, y: 5 }];
  assert.deepEqual([tweenPoint(drop, 0, 'place').x, tweenPoint(drop, 0, 'place').y], [4, 5]);
  assert.equal(tweenPoint(drop, 0, 'place').lift, 1, 'a placement starts high');
  assert.equal(tweenPoint(drop, 1, 'place').lift, 0, 'and lands');
});

test('tweenPoint: a slide moves at constant speed along the polyline', () => {
  const pts = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 30 }]; // length 40
  const at = t => { const p = tweenPoint(pts, t, 'slide'); return [p.x, p.y]; };
  assert.deepEqual(at(0.25), [10, 0]);
  assert.deepEqual(at(0.5), [10, 10]);
  assert.deepEqual(at(0.125), [5, 0]);
  assert.deepEqual(at(2), [10, 30], 'clamped');
});

test('tweenPoint: hop lift peaks at t=0.5 and is symmetric', () => {
  const pts = [{ x: 0, y: 0 }, { x: 100, y: 0 }];
  const lift = t => tweenPoint(pts, t, 'hop').lift;
  assert.ok(near(lift(0.5), 1));
  for (const t of [0.1, 0.3, 0.45, 0.55, 0.7, 0.9]) assert.ok(lift(t) < 1, `t=${t}`);
  assert.ok(near(lift(0.3), lift(0.7)));
  assert.ok(lift(0.3) > lift(0.1));
});

test('moveDuration: ~120 ms per hex, never over the 700 ms budget (incl. landing)', () => {
  assert.ok(moveDuration('slide', 4) >= 400);
  assert.ok(moveDuration('slide', 6) > moveDuration('slide', 3));
  for (const kind of [...KINDS, 'place']) {
    for (const steps of [1, 2, 5, 12]) {
      const d = moveDuration(kind, steps);
      assert.ok(d > 0 && d + LAND_MS <= 700, `${kind} × ${steps}: ${d} + ${LAND_MS}`);
    }
  }
});

function boardWithMove() {
  const { board } = makeBoard();
  board.pieces.set('0,0', [{ player: 2, type: 'QUEEN' }]);
  board.pieces.set('2,0', [{ player: 1, type: 'ANT' }]);
  return board;
}

test('animateMove hides the arriving top piece and flies it, then lands with FX', async () => {
  const board = boardWithMove();
  let done = false;
  const p = board.animateMove({ path: ['-1,0', '-1,1', '0,1', '1,1', '2,0'], kind: 'slide', toKey: '2,0' }).then(() => { done = true; });
  assert.ok(board.hiddenTop.has('2,0'), 'top piece left out of the layer while in flight');
  assert.equal(board.floating.length, 1);
  assert.equal(board.floating[0].piece.type, 'ANT');

  board.draw(1000);
  const start = { x: board.floating[0].x, y: board.floating[0].y };
  board.draw(1150);
  assert.ok(board.floating[0].x !== start.x || board.floating[0].y !== start.y, 'the piece moves');
  board.draw(1500);   // 4 steps = 480 ms: just past touchdown
  assert.ok(board.particles.length >= 10 && board.particles.length <= 16, `sparks: ${board.particles.length}`);
  assert.ok(board.hiddenTop.has('2,0'), 'still settling');
  board.draw(1700);   // past the landing settle
  await p;
  assert.ok(done);
  assert.equal(board.floating.length, 0);
  assert.equal(board.hiddenTop.size, 0);
  board.draw(5000);
  assert.equal(board.particles.length, 0, 'sparks are culled when spent');
});

test('finishAnimations completes a flight at once: nothing hidden, nothing floating, promise resolved', async () => {
  const board = boardWithMove();
  const p = board.animateMove({ path: ['-1,0', '2,0'], kind: 'hop', toKey: '2,0' });
  board.draw(1000); board.draw(1100);
  board.finishAnimations({ clearFx: true });
  await p;
  assert.equal(board.floating.length, 0);
  assert.equal(board.hiddenTop.size, 0);
  assert.equal(board.particles.length, 0);
});

test('reduced motion: animateMove is instant with no particles or shake', async () => {
  const board = boardWithMove();
  board.reducedMotion = true;
  await board.animateMove({ path: ['-1,0', '2,0'], kind: 'climb', toKey: '2,0' });
  assert.equal(board.floating.length, 0);
  assert.equal(board.hiddenTop.size, 0);
  board.draw(1000); board.draw(2000);
  assert.equal(board.particles.length, 0);
});

test('reveal pans gently to show off-screen targets and leaves visible ones alone', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  board.pieces.set('0,0', [{ player: 1, type: 'ANT' }]);
  board.recenter(false);
  const before = { tx: board.tx, ty: board.ty, scale: board.scale };
  assert.equal(board.reveal(['0,0', '1,0']), false, 'already visible: no camera move');
  assert.deepEqual({ tx: board.tx, ty: board.ty, scale: board.scale }, before);

  board.tx -= 300; // the user panned the hive mostly off to the left
  assert.equal(board.reveal(['0,0']), true);
  board.draw(0); board.draw(2000);
  const { x, y } = board.hexToScreen('0,0');
  const r = board.SIZE * board.scale;
  assert.ok(x - r >= 0 && x + r <= 400 && y - r >= 52 && y + r <= 800 - 112, 'target now in the playable area');
  assert.equal(board.scale, before.scale, 'a pan was enough: no zoom');
});

test('reveal zooms out only when the targets cannot fit at the current zoom', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  board.scale = 1.25;
  const keys = ['-6,0', '6,0'];
  for (const k of keys) board.pieces.set(k, [{ player: 1, type: 'ANT' }]);
  assert.equal(board.reveal(keys), true);
  board.draw(0); board.draw(2000);
  assert.ok(board.scale < 1.25);
  for (const k of keys) {
    const { x } = board.hexToScreen(k);
    assert.ok(x >= 0 && x <= 400, `${k} visible`);
  }
});

test('reveal keeps its context (the hive) in view when it has to move anyway', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  const hive = ['-2,0', '-1,0', '0,0', '1,0'];
  for (const k of hive) board.pieces.set(k, [{ player: 1, type: 'ANT' }]);
  board.recenter(false);
  assert.equal(board.reveal(['-1,0'], hive), false, 'target visible: context alone never moves the camera');
  assert.equal(board.reveal(['3,0'], hive), true);
  board.draw(0); board.draw(2000);
  for (const k of [...hive, '3,0']) {
    const { x } = board.hexToScreen(k);
    assert.ok(x - board.SIZE * board.scale >= 0 && x + board.SIZE * board.scale <= 400, `${k} in view`);
  }
});

test('reveal does not fight a user who is panning', () => {
  const { board, canvas } = makeBoard();
  board.pieces.set('0,0', [{ player: 1, type: 'ANT' }]);
  board.tx = -2000;
  canvas.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 400 });
  canvas.fire('pointermove', { pointerId: 1, clientX: 140, clientY: 400 });
  assert.equal(board.reveal(['0,0']), false, 'pointer down');
  canvas.fire('pointerup', { pointerId: 1, clientX: 140, clientY: 400 });
  assert.equal(board.reveal(['0,0']), false, 'just finished a drag');
});

test('onLand fires once at touchdown with the kind and player, not when a flight is snapped home', async () => {
  const board = boardWithMove();
  const landed = [];
  board.onLand = (kind, player) => landed.push([kind, player]);
  const p = board.animateMove({ path: ['-1,0', '2,0'], kind: 'hop', toKey: '2,0' });
  board.draw(1000);
  assert.deepEqual(landed, [], 'not at departure');
  board.draw(1100); board.draw(1400); board.draw(1450);
  assert.deepEqual(landed, [['hop', 1]]);
  board.draw(1800);
  await p;
  assert.equal(landed.length, 1);

  const q = board.animateMove({ path: ['-1,0', '2,0'], kind: 'slide', toKey: '2,0' });
  board.draw(2000);
  board.finishAnimations();
  await q;
  assert.equal(landed.length, 1, 'a snapped flight makes no landing');
});

// ── Queen danger pips ────────────────────────────────────────────────────────

const pc = (player, type) => ({ player, type });

test('queenPips: one entry per queen, a pip lit for each occupied side', () => {
  const pieces = new Map([
    ['0,0', [pc(1, 'QUEEN')]], ['1,0', [pc(2, 'ANT')]], ['0,1', [pc(2, 'QUEEN')]],
  ]);
  const pips = queenPips(pieces);
  assert.equal(pips.length, 2);
  const p1 = pips.find(q => q.player === 1);
  assert.equal(p1.key, '0,0');
  assert.equal(p1.count, 2);
  assert.equal(p1.lit.length, 6);
  assert.equal(p1.lit.filter(Boolean).length, 2);
  assert.equal(pips.find(q => q.player === 2).count, 2, '0,0 and 1,0 both touch 0,1');
});

test('queenPips: each pip points at its neighbour', () => {
  const pieces = new Map([['0,0', [pc(1, 'QUEEN')]], ['0,-1', [pc(2, 'ANT')]]]);
  const [q] = queenPips(pieces);
  const i = q.lit.indexOf(true);
  const n = hexToPixel(0, -1, 1);
  const len = Math.hypot(n.x, n.y);
  assert.ok(Math.abs(q.dirs[i].x - n.x / len) < 1e-9 && Math.abs(q.dirs[i].y - n.y / len) < 1e-9);
});

test('queenPips: a piece still in flight onto an empty hex does not light its pip yet', () => {
  const pieces = new Map([['0,0', [pc(1, 'QUEEN')]], ['1,0', [pc(2, 'ANT')]], ['-1,0', [pc(2, 'ANT')]]]);
  const [q] = queenPips(pieces, new Set(['1,0']));
  assert.equal(q.count, 1);
});

test('queenPips: a flying queen has no pips; a queen under an arriving beetle keeps them', () => {
  const pieces = new Map([['0,0', [pc(1, 'QUEEN')]], ['1,0', [pc(2, 'QUEEN'), pc(1, 'BEETLE')]]]);
  const flying = queenPips(pieces, new Set(['0,0']));
  assert.deepEqual(flying.map(q => q.key), ['1,0']);
  const buried = queenPips(pieces, new Set(['1,0']));
  assert.deepEqual(buried.map(q => q.key).sort(), ['0,0', '1,0']);
  assert.equal(buried.find(q => q.key === '1,0').height, 1, 'on the queen while the beetle is in the air');
  assert.equal(queenPips(pieces).find(q => q.key === '1,0').height, 2, 'then on the stack top');
});

// ── Win sequence ─────────────────────────────────────────────────────────────

test('winTiming: the card is never later than the 1.6 s reveal budget', () => {
  assert.ok(WIN_REVEAL_MAX_MS <= 1600);
  for (const kind of ['slide', 'hop', 'climb', 'throw', 'place']) {
    for (const steps of [1, 2, 3, 5, 12]) {
      const w = winTiming(kind, steps);
      assert.ok(w.flightMs >= moveDuration(kind, steps) * 1.8, `${kind}/${steps} plays in slow motion`);
      assert.ok(w.landMs > w.flightMs && w.cardMs > w.landMs);
      assert.ok(w.cardMs <= WIN_REVEAL_MAX_MS, `${kind}/${steps}: card at ${w.cardMs} ms`);
    }
  }
});

test('winTiming: no flight (pass, resign, reduced motion) shows the card after 300 ms', () => {
  assert.deepEqual(winTiming(null, 0), { flightMs: 0, landMs: 0, cardMs: 300 });
  assert.deepEqual(winTiming('slide', 3, { reducedMotion: true }), { flightMs: 0, landMs: 0, cardMs: 300 });
});

test('animateMove with speed 0.4 plays the move in slow motion', async () => {
  const board = boardWithMove();
  const p = board.animateMove({ path: ['-1,0', '-1,1', '0,1', '1,1', '2,0'], kind: 'slide', toKey: '2,0', speed: 0.4 });
  assert.equal(board._flights[0].dur, winTiming('slide', 4).flightMs);
  board.draw(1000);
  board.draw(1000 + moveDuration('slide', 4) + 20);
  assert.ok(board.particles.length === 0, 'not landed at normal speed');
  board.finishAnimations();
  await p;
});

test('shockwave: rings out from each queen and fades; none under reduced motion', () => {
  const board = boardWithMove();
  board.shockwave(['0,0']);
  board.draw(1000);
  assert.equal(board._shockwaves.length, 1);
  board.draw(1300);
  assert.equal(board._shockwaves.length, 1, 'still expanding');
  board.draw(3000);
  assert.equal(board._shockwaves.length, 0, 'culled when spent');

  board.reducedMotion = true;
  board.shockwave(['0,0']);
  assert.equal(board._shockwaves.length, 0);
});

test('finishAnimations({clearFx}) drops a running shockwave', () => {
  const board = boardWithMove();
  board.shockwave(['0,0']);
  board.finishAnimations({ clearFx: true });
  assert.equal(board._shockwaves.length, 0);
});

// ── Airborne pieces occlude the hive ─────────────────────────────────────────

/** A context that logs fills/strokes/drawImage with the composite op in force. */
function recordingCanvas(log) {
  const c = fakeCanvas();
  const stub = new Proxy(function () {}, { get: () => stub, apply: () => stub });
  const state = { globalCompositeOperation: 'source-over', globalAlpha: 1 };
  const saved = [];
  const ctx = new Proxy(state, {
    get: (t, key) => {
      if (key === 'save') return () => saved.push({ ...t });
      if (key === 'restore') return () => Object.assign(t, saved.pop());
      if (key in t) return t[key];
      if (['fill', 'stroke', 'drawImage', 'clearRect', 'fillText'].includes(key)) return () => log.push({ op: key, gco: t.globalCompositeOperation });
      return () => stub;
    },
    set: (t, key, v) => { t[key] = v; return true; },
  });
  c.getContext = () => ctx;
  return c;
}

test('a piece in the air erases the glyphs beneath it before its own glyph is drawn', async () => {
  const log = [];
  const board = new Board(fakeCanvas(), recordingCanvas(log));
  board._makeCanvas = fakeCanvas;
  board.reducedMotion = false;
  board.resize(400, 800);
  board.pieces.set('0,0', [{ player: 2, type: 'BEETLE' }]);
  board.pieces.set('1,0', [{ player: 2, type: 'QUEEN' }]);
  board.pieces.set('2,0', [{ player: 1, type: 'GRASSHOPPER' }]);
  const p = board.animateMove({ path: ['-1,0', '2,0'], kind: 'hop', toKey: '2,0' });
  board.draw(1000);
  log.length = 0;
  board.draw(1150); // mid-hop, over the hive
  const cut = log.findIndex(e => e.op === 'fill' && e.gco === 'destination-out');
  assert.ok(cut >= 0, 'the floating tile is cut out of #emoji-layer');
  const glyphAfter = log.slice(cut + 1).some(e => e.gco === 'source-over' && ['fill', 'stroke', 'drawImage', 'fillText'].includes(e.op));
  assert.ok(glyphAfter, 'its own glyph is drawn after the cut');
  board.finishAnimations();
  await p;
});

test('queen pips and selection rings are painted under a floating piece, not over it', async () => {
  const board = boardWithMove();
  const order = [];
  for (const m of ['_drawQueenPips', '_drawSelectionRing', '_drawThrowPick', '_drawGhostPulses', '_drawFloating']) {
    const orig = board[m].bind(board);
    board[m] = (...a) => { order.push(m); return orig(...a); };
  }
  const p = board.animateMove({ path: ['-1,0', '2,0'], kind: 'hop', toKey: '2,0' });
  board.draw(1000); board.draw(1100);
  const fl = order.lastIndexOf('_drawFloating');
  for (const m of ['_drawQueenPips', '_drawSelectionRing', '_drawThrowPick', '_drawGhostPulses']) {
    assert.ok(order.lastIndexOf(m) < fl, `${m} before the floating piece`);
  }
  board.finishAnimations();
  await p;
});

// ── Reveal: zoom-out floor and the user's own zoom ───────────────────────────

/** Landscape phone: 844×390 with slim chrome; a hive far too tall to show whole at a readable size. */
function landscapeBoard() {
  const { board } = makeBoard();
  board.resize(844, 390);
  board.insets = { top: 46, bottom: 64 };
  return board;
}
const onScreen = (board, k) => {
  const { x, y } = board.hexToScreen(k);
  const r = board.SIZE * board.scale * 0.5;
  return x - r >= 0 && x + r <= board.W && y - r >= board.insets.top && y + r <= board.H - board.insets.bottom;
};
const settle = board => { board.draw(0); board.draw(5000); };

test('REVEAL_MIN_TILE_PX is a readable tile radius (16-18 px)', () => {
  assert.ok(REVEAL_MIN_TILE_PX >= 16 && REVEAL_MIN_TILE_PX <= 18);
});

test('reveal never zooms tiles below the floor; it frames the piece and its nearest targets instead', () => {
  const board = landscapeBoard();
  const column = Array.from({ length: 15 }, (_, i) => `0,${i - 7}`);
  for (const k of column) board.pieces.set(k, [{ player: 1, type: 'ANT' }]);
  board.scale = 0.5; board.tx = 422; board.ty = 214;
  const ant = '0,5';
  const targets = ['1,4', '-1,6', '1,-7', '-1,-6', '0,-8'];
  assert.equal(board.reveal([ant, ...targets], column, { anchor: ant }), true);
  settle(board);
  assert.ok(board.scale * board.SIZE >= REVEAL_MIN_TILE_PX - 1e-9, `tile radius ${board.scale * board.SIZE}`);
  assert.ok(onScreen(board, ant), 'the selected piece stays in view');
  assert.ok(onScreen(board, '1,4') && onScreen(board, '-1,6'), 'its nearest targets are framed');
});

test('reveal still zooms out as far as needed when that stays above the floor', () => {
  const board = landscapeBoard();
  board.scale = 1;
  const keys = ['-4,0', '4,0'];
  assert.equal(board.reveal(keys), true);
  settle(board);
  assert.ok(board.scale < 1 && board.scale * board.SIZE >= REVEAL_MIN_TILE_PX);
  for (const k of keys) assert.ok(onScreen(board, k), `${k} visible`);
});

test('an already zoomed-out camera is never zoomed out further by a reveal', () => {
  const board = landscapeBoard();
  board.scale = 0.26; board.tx = 422; board.ty = 214;
  const keys = ['0,-14', '0,14'];
  board.reveal(keys);
  settle(board);
  assert.equal(board.scale, 0.26);
});

test('after a manual zoom, reveals pan but keep the chosen zoom until recenter', () => {
  const { board } = makeBoard();
  board.insets = { top: 52, bottom: 112 };
  board.pieces.set('0,0', [{ player: 1, type: 'ANT' }]);
  board.recenter(false);
  board.zoomBy(0.9);
  board._userCameraAt = -Infinity; // long after the zoom: the grace period is over
  const chosen = board.scale;
  const keys = ['0,0', '-7,0', '7,0'];
  assert.equal(board.reveal(keys, [], { anchor: '0,0' }), true);
  settle(board);
  assert.equal(board.scale, chosen, 'the user\'s zoom is kept');
  assert.ok(onScreen(board, '0,0'));

  board.recenter(false);
  board.scale = 1;
  board.reveal(keys);
  settle(board);
  assert.ok(board.scale < 1, 'after recenter, reveals may zoom out again');
});

test('flightMs reports the running flight\'s tween duration, 0 when idle', async () => {
  const board = boardWithMove();
  assert.equal(board.flightMs(), 0);
  const p = board.animateMove({ path: ['-1,0', '-1,1', '0,1', '1,1', '2,0'], kind: 'slide', toKey: '2,0' });
  assert.equal(board.flightMs(), moveDuration('slide', 4));
  board.finishAnimations();
  await p;
  assert.equal(board.flightMs(), 0);
});
