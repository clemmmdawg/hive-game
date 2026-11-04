import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, serializeState, deserializeState, ActionType, PieceType, getLegalPlacements } from '../js/game.js';
import { toNotation, pieceIds, MARKERS } from '../js/notation.js';

const place = (pieceType, to) => ({ type: 'PLACE', pieceType, to });
function play(actions, settings = {}) {
  let s = createGame(settings); const out = [];
  for (const a of actions) { out.push(toNotation(s, a)); s = applyAction(s, a); }
  return { s, out };
}

test('first placement and numbering', () => {
  const { out } = play([place('ANT', '0,0'), place('SPIDER', '1,0'), place('ANT', '-1,0')]);
  assert.deepEqual(out.slice(0, 2), ['wA1', 'bS1 wA1-']);
  assert.match(out[2], /^wA2 /);
});

test('queen and expansion pieces are unnumbered; second ant is 2', () => {
  const { out } = play([place('QUEEN', '0,0'), place('QUEEN', '1,0'), place('ANT', '-1,0'), place('ANT', '2,0'), place('ANT', '-2,0')],
    { expansions: { pillbug: true } });
  assert.equal(out[0], 'wQ'); assert.equal(out[1], 'bQ wQ-');
  assert.equal(out[2].split(' ')[0], 'wA1'); assert.equal(out[4].split(' ')[0], 'wA2');
});

test('marker table covers all six directions with distinct markers', () => {
  assert.equal(new Set(MARKERS).size, 6);
  // destination at each DIRS offset from a lone reference
  const offs = [[1,0],[1,-1],[0,-1],[-1,0],[-1,1],[0,1]];
  offs.forEach(([dq, dr], d) => {
    const { out } = play([place('ANT', '0,0'), place('SPIDER', `${dq},${dr}`)]);
    assert.equal(out[1], 'bS1 ' + MARKERS[d].replace('X', 'wA1'));
  });
});

test('beetle climb, move keeps id, and pass', () => {
  const setup = [place('QUEEN', '0,0'), place('QUEEN', '1,0'), place('BEETLE', '-1,0'), place('ANT', '2,0')];
  const { s, out } = play([...setup, { type: 'MOVE', from: '-1,0', to: '0,0' }, { type: 'PASS' }]);
  assert.equal(out[4], 'wB1 wQ');
  assert.equal(out[5], 'pass');
  assert.deepEqual(pieceIds(s).get('0,0'), ['wQ', 'wB1']);
});

test('moved piece keeps its id', () => {
  const { s, out } = play([place('QUEEN', '0,0'), place('QUEEN', '1,0'), place('ANT', '-1,0'), place('ANT', '2,0'),
    { type: 'MOVE', from: '-1,0', to: '0,1' }]);
  assert.match(out[4], /^wA1 /);
  assert.deepEqual(pieceIds(s).get('0,1'), ['wA1']);
});

test('throw reports the thrown piece id and destination', () => {
  const { s } = play([place('PILLBUG', '0,0'), place('QUEEN', '1,0'), place('QUEEN', '-1,0'), place('ANT', '2,0')],
    { expansions: { pillbug: true } });
  const t = { type: 'THROW', pillbugHex: '0,0', from: '-1,0', to: '0,1' };
  const n = toNotation(s, t);
  // first occupied neighbour of 0,1 in DIRS order is bQ at NE (1,0): moved piece sits on its SW side
  assert.equal(n, 'wQ \\bQ');
});

test('ids survive serialize round trip; id-less saves get deterministic ids', () => {
  const { s } = play([place('ANT', '0,0'), place('ANT', '1,0')]);
  assert.deepEqual(pieceIds(deserializeState(JSON.parse(JSON.stringify(serializeState(s))))), pieceIds(s));
  const legacy = deserializeState(JSON.parse(JSON.stringify(serializeState(s))));
  for (const st of legacy.board.values()) for (const p of st) delete p.id;
  const a = pieceIds(legacy), b = pieceIds(legacy);
  assert.deepEqual(a, b);
  assert.equal(new Set([...a.values()].flat()).size, 2);
});

// ── Move log (Task 12) ───────────────────────────────────────────────────────

import { logEntry, undoLogEntry } from '../js/notation.js';
import { stampPieceIds } from '../js/game.js';

test('logEntry keeps the action, notation, mover and turn number', () => {
  const s = createGame({});
  const [to] = getLegalPlacements(s, PieceType.ANT);
  const action = { type: ActionType.PLACE, pieceType: PieceType.ANT, to };
  assert.deepEqual(logEntry(s, action), { notation: 'wA1', player: 1, turnNumber: s.turnNumber, action });
  assert.equal(logEntry(s, { type: ActionType.PASS }).notation, 'pass');
});

test('undoLogEntry pops the last move and any forced passes after it', () => {
  const mv = n => ({ notation: n, action: { type: 'PLACE' } });
  const ps = { notation: 'pass', action: { type: 'PASS' } };
  assert.deepEqual(undoLogEntry([mv('a'), mv('b')]).map(e => e.notation), ['a']);
  assert.deepEqual(undoLogEntry([mv('a'), mv('b'), ps]).map(e => e.notation), ['a']);
  assert.deepEqual(undoLogEntry([mv('a'), ps, mv('b')]).map(e => e.notation), ['a', 'pass']);
  assert.deepEqual(undoLogEntry([]), []);
});

test('legacy id-less states are stamped once on load, so notation is consistent', () => {
  let s = createGame({});
  for (const t of [PieceType.ANT, PieceType.ANT, PieceType.ANT]) {
    const [to] = getLegalPlacements(s, t);
    s = applyAction(s, { type: ActionType.PLACE, pieceType: t, to });
  }
  const raw = JSON.parse(JSON.stringify(serializeState(s)));
  for (const [, stack] of raw.board) for (const p of stack) delete p.id;
  const loaded = deserializeState(raw);
  for (const stack of loaded.board.values()) for (const p of stack) assert.ok(p.id);
  assert.equal(stampPieceIds(loaded), loaded, 'already stamped: same object');
  // The next placement names pieces by the stamped ids, and an id-less prev state gives the same text.
  const [dest] = getLegalPlacements(loaded, PieceType.BEETLE);
  const act = { type: ActionType.PLACE, pieceType: PieceType.BEETLE, to: dest };
  const n = toNotation(loaded, act);
  const all = new Set([...loaded.board.values()].flat().map(p => p.id));
  const refs = n.replace(/[/\\-]/g, ' ').split(' ').filter(Boolean).slice(1);
  assert.ok(refs.length === 1 && all.has(refs[0]), n);
  const bare = deserializeState(raw);
  for (const stack of bare.board.values()) for (const p of stack) delete p.id;
  assert.equal(toNotation(bare, act), n);
});
