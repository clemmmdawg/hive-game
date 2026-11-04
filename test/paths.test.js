import test from 'node:test';
import assert from 'node:assert/strict';

import {
  PieceType, createGame, getMovePath, getLegalMoves, getLegalThrows,
  getAllLegalActions, applyAction, neighbors, parseKey, hexKey, checkWin,
} from '../js/game.js';

const P = (player, type) => ({ player, type });

function position(entries, { turn = 1 } = {}) {
  const state = createGame({ expansions: { mosquito: true, ladybug: true, pillbug: true } });
  state.board = new Map(entries);
  state.queenPlaced = { 1: true, 2: true };
  state.turn = turn;
  return state;
}

const adjacent = (a, b) => {
  const { q, r } = parseKey(a);
  return neighbors(q, r).some(n => hexKey(n.q, n.r) === b);
};
const allAdjacent = path => path.every((k, i) => i === 0 || adjacent(path[i - 1], k));
const mv = (state, from, to) => getMovePath(state, { type: 'MOVE', from, to });

// A ring-ish hive: a row of queens/pieces along r=0 for edge walking.
const row = (mine, extra = []) => position([
  ['0,0', [P(1, mine)]],
  ['1,0', [P(2, PieceType.QUEEN)]],
  ['2,0', [P(1, PieceType.QUEEN)]],
  ['3,0', [P(2, PieceType.BEETLE)]],
  ...extra,
]);

test('PLACE yields [to]; PASS and illegal actions yield null', () => {
  const s = createGame({});
  const to = '0,0';
  assert.deepEqual(getMovePath(s, { type: 'PLACE', pieceType: 'ANT', to }), { path: [to], kind: 'place' });
  assert.equal(getMovePath(s, { type: 'PLACE', pieceType: 'ANT', to: '9,9' }), null);
  assert.equal(getMovePath(s, { type: 'PASS' }), null);
});

test('queen and pillbug slide one step', () => {
  for (const t of [PieceType.QUEEN, PieceType.PILLBUG]) {
    const s = row(t);
    const dest = getLegalMoves(s, '0,0')[0];
    const res = mv(s, '0,0', dest);
    assert.equal(res.kind, 'slide');
    assert.deepEqual(res.path, ['0,0', dest]);
  }
});

test('beetle climbs', () => {
  const s = row(PieceType.BEETLE);
  assert.deepEqual(mv(s, '0,0', '1,0'), { path: ['0,0', '1,0'], kind: 'climb' });
});

test('grasshopper hop lists every jumped hex', () => {
  const s = row(PieceType.GRASSHOPPER);
  assert.deepEqual(mv(s, '0,0', '4,0'), { path: ['0,0', '1,0', '2,0', '3,0', '4,0'], kind: 'hop' });
});

test('ant path is a shortest legal slide path', () => {
  const s = row(PieceType.ANT);
  for (const to of getLegalMoves(s, '0,0')) {
    const res = mv(s, '0,0', to);
    assert.equal(res.kind, 'slide');
    assert.equal(res.path[0], '0,0');
    assert.equal(res.path.at(-1), to);
    assert.ok(allAdjacent(res.path));
    assert.equal(new Set(res.path).size, res.path.length);
    assert.ok(!res.path.slice(1).some(k => s.board.has(k) && k !== '0,0'), 'never passes through pieces');
  }
});

test('spider path has exactly 4 distinct entries', () => {
  const s = position([
    ['0,0', [P(1, PieceType.SPIDER)]],
    ['1,0', [P(2, PieceType.QUEEN)]],
    ['2,0', [P(1, PieceType.QUEEN)]],
    ['3,0', [P(2, PieceType.ANT)]],
  ]);
  const dests = getLegalMoves(s, '0,0');
  assert.ok(dests.length > 0);
  for (const to of dests) {
    const res = mv(s, '0,0', to);
    assert.equal(res.kind, 'slide');
    assert.equal(res.path.length, 4);
    assert.equal(new Set(res.path).size, 4);
    assert.ok(allAdjacent(res.path));
    assert.equal(res.path[3], to);
  }
});

test('ladybug path has length 4 and kind climb', () => {
  const s = position([
    ['0,0', [P(1, PieceType.LADYBUG)]],
    ['1,0', [P(2, PieceType.QUEEN)]],
    ['2,0', [P(1, PieceType.QUEEN)]],
    ['3,0', [P(2, PieceType.ANT)]],
  ]);
  const dests = getLegalMoves(s, '0,0');
  assert.ok(dests.length > 0);
  for (const to of dests) {
    const res = mv(s, '0,0', to);
    assert.equal(res.kind, 'climb');
    assert.equal(res.path.length, 4);
    assert.ok(allAdjacent(res.path));
    assert.equal(res.path[3], to);
  }
});

test('mosquito copying ant yields a slide path; on top of hive it climbs', () => {
  const s = position([
    ['0,0', [P(1, PieceType.MOSQUITO)]],
    ['1,0', [P(2, PieceType.ANT)]],
    ['2,0', [P(1, PieceType.QUEEN)]],
    ['3,0', [P(2, PieceType.QUEEN)]],
  ]);
  const far = '3,-1';
  assert.ok(getLegalMoves(s, '0,0').includes(far));
  const res = mv(s, '0,0', far);
  assert.equal(res.kind, 'slide');
  assert.ok(res.path.length > 2 && allAdjacent(res.path));

  const top = position([
    ['0,0', [P(2, PieceType.QUEEN), P(1, PieceType.MOSQUITO)]],
    ['1,0', [P(1, PieceType.ANT)]],
  ]);
  assert.equal(mv(top, '0,0', '1,0').kind, 'climb');
});

test('illegal destinations give null', () => {
  const s = row(PieceType.SPIDER);
  assert.equal(mv(s, '0,0', '1,0'), null);        // occupied
  assert.equal(mv(s, '0,0', '8,8'), null);        // far away
  assert.equal(mv(s, '1,0', '1,1'), null);        // opponent's piece (not your turn)
  assert.equal(mv(s, '5,5', '1,1'), null);        // empty origin
});

test('throw path is [from, pillbug, to]', () => {
  const s = position([
    ['0,0', [P(1, PieceType.PILLBUG)]],
    ['1,0', [P(2, PieceType.ANT)]],
    ['-1,0', [P(1, PieceType.QUEEN)]],
    ['0,1', [P(2, PieceType.QUEEN)]],
  ]);
  const t = getLegalThrows(s)[0];
  assert.ok(t);
  assert.deepEqual(getMovePath(s, { type: 'THROW', ...t }), { path: [t.from, t.pillbugHex, t.to], kind: 'throw' });
  assert.equal(getMovePath(s, { type: 'THROW', pillbugHex: '0,0', from: '1,0', to: '1,0' }), null);
});

// ── Property check over random games ─────────────────────────────────────────

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('property: every legal action in random games has a valid path', () => {
  let checked = 0;
  const kinds = new Set();
  for (let seed = 1; seed <= 12; seed++) {
    const rand = rng(seed);
    let s = createGame({ expansions: { mosquito: true, ladybug: true, pillbug: true } });
    for (let ply = 0; ply < 70 && !s.winner; ply++) {
      const acts = getAllLegalActions(s);
      const list = [];
      for (const [pt, hexes] of acts.placements) for (const to of hexes) list.push({ type: 'PLACE', pieceType: pt, to });
      for (const [from, tos] of acts.moves) for (const to of tos) list.push({ type: 'MOVE', from, to });
      for (const t of acts.throws) list.push({ type: 'THROW', ...t });

      for (const a of list) {
        const res = getMovePath(s, a);
        assert.ok(res, `seed ${seed} ply ${ply}: null path for ${JSON.stringify(a)}`);
        kinds.add(res.kind);
        checked++;
        if (a.type === 'PLACE') { assert.deepEqual(res.path, [a.to]); continue; }
        if (a.type === 'THROW') { assert.deepEqual(res.path, [a.from, a.pillbugHex, a.to]); assert.ok(allAdjacent(res.path)); continue; }
        assert.equal(res.path[0], a.from);
        assert.equal(res.path.at(-1), a.to);
        if (res.kind === 'hop') {
          assert.ok(res.path.length >= 3);
          assert.ok(res.path.slice(1, -1).every(k => s.board.has(k)));
        } else {
          assert.ok(allAdjacent(res.path), `seed ${seed}: non-adjacent step in ${res.path}`);
          assert.equal(new Set(res.path).size, res.path.length);
        }
      }
      if (acts.mustPass || list.length === 0) { s = applyAction(s, { type: 'PASS' }); continue; }
      s = applyAction(s, list[Math.floor(rand() * list.length)]);
    }
  }
  assert.ok(checked > 500, `only ${checked} actions checked`);
  for (const k of ['slide', 'hop', 'climb', 'place']) assert.ok(kinds.has(k), `kind ${k} never exercised`);
});
