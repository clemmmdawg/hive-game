import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGame, applyAction, getAllLegalActions, ActionType, PieceType } from '../js/game.js';
import { logEntry } from '../js/notation.js';
import { createReplay, replayForGame, sameBoard, plyInfo, movesText, notationHTML } from '../js/replay.js';

const place = (pieceType, to) => ({ type: ActionType.PLACE, pieceType, to });
const move = (from, to) => ({ type: ActionType.MOVE, from, to });

/** A real game (log + live state), recorded the way app.js does. */
function record(actions, settings = {}) {
  let state = createGame(settings);
  const log = [];
  for (const a of actions) { log.push(logEntry(state, a)); state = applyAction(state, a); }
  return { state, log };
}

const OPENING = [
  place(PieceType.ANT, '0,0'), place(PieceType.SPIDER, '1,0'),
  place(PieceType.QUEEN, '-1,0'), place(PieceType.QUEEN, '2,0'),
  move('-1,0', '-1,1'), place(PieceType.BEETLE, '2,1'),
];

/** Deterministic pseudo-random game of `n` legal plies, all expansions on. */
function randomGame(n, seed = 7) {
  const settings = { expansions: { mosquito: true, ladybug: true, pillbug: true } };
  let state = createGame(settings), rnd = seed;
  const next = k => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd % k; };
  const actions = [];
  for (let i = 0; i < n && !state.winner; i++) {
    const all = getAllLegalActions(state);
    const options = [
      ...[...all.placements].flatMap(([pieceType, keys]) => keys.map(to => place(pieceType, to))),
      ...[...all.moves].flatMap(([from, keys]) => keys.map(to => move(from, to))),
      ...all.throws.map(t => ({ type: ActionType.THROW, ...t })),
    ];
    const a = options.length ? options[next(options.length)] : { type: ActionType.PASS };
    actions.push(a);
    state = applyAction(state, a);
  }
  return { settings, actions, state };
}

test('replay of N actions has N+1 states, the last equal to the game', () => {
  const { settings, actions, state } = randomGame(40);
  const replay = createReplay(settings, actions);
  assert.equal(replay.states.length, actions.length + 1);
  assert.equal(replay.states[0].board.size, 0);
  assert.ok(sameBoard(replay.states.at(-1).board, state.board));
  assert.equal(replay.states.at(-1).turnNumber, state.turnNumber);
});

test('replay starts at the opening and steps / seeks within bounds', () => {
  const { log } = record(OPENING);
  const replay = createReplay({}, log.map(e => e.action));
  assert.equal(replay.index, 0);
  assert.equal(replay.step(1), 1);
  assert.equal(replay.state.board.size, 1);
  assert.equal(replay.step(-1), 0);
  assert.equal(replay.step(-1), 0, 'clamped at the start');
  assert.equal(replay.seek(99), OPENING.length, 'clamped at the end');
  assert.ok(replay.atEnd);
  assert.equal(replay.seek(3), 3);
  assert.equal(replay.state, replay.states[3]);
  assert.equal(createReplay({}, log.map(e => e.action), { index: 4 }).index, 4);
});

test('replay never touches the states it was built from', () => {
  const { state, log } = record(OPENING);
  const before = JSON.stringify([...state.board]);
  const replay = createReplay({}, log.map(e => e.action));
  replay.seek(2);
  replay.state.board.clear(); // even a careless consumer cannot reach the live game
  assert.equal(JSON.stringify([...state.board]), before);
});

test('replayForGame: a log that reproduces the live game is replayable', () => {
  const { state, log } = record(OPENING);
  const replay = replayForGame(log, state);
  assert.ok(replay);
  assert.equal(replay.states.length, OPENING.length + 1);
  assert.ok(sameBoard(replay.states.at(-1).board, state.board));
});

test('replayForGame: the log of an empty game is a one-state replay', () => {
  const replay = replayForGame([], createGame({}));
  assert.equal(replay.states.length, 1);
});

test('replayForGame: a v1 save (empty log, pieces on the board) is not replayable', () => {
  const { state } = record(OPENING);
  assert.equal(replayForGame([], state), null);
});

test('replayForGame: a partial log that does not reach the live board is not replayable', () => {
  const { state, log } = record(OPENING);
  assert.equal(replayForGame(log.slice(2), state), null);
  assert.equal(replayForGame(log.slice(0, -1), state), null);
});

test('replayForGame: malformed entries are rejected, not thrown', () => {
  const { state, log } = record(OPENING);
  assert.equal(replayForGame([...log.slice(0, 4), { notation: '?' }, ...log.slice(5)], state), null);
  assert.equal(replayForGame([...log.slice(0, 4), { notation: 'x', action: { type: 'MOVE', from: '9,9', to: '0,0' } }, ...log.slice(5)], state), null);
  assert.equal(replayForGame(null, state), null);
});

test('replayForGame uses the game\'s own settings (expansion supply)', () => {
  const settings = { expansions: { mosquito: true, ladybug: false, pillbug: true } };
  const { state, log } = record([place(PieceType.MOSQUITO, '0,0'), place(PieceType.PILLBUG, '1,0')], settings);
  const replay = replayForGame(log, state);
  assert.ok(replay);
  assert.equal(replay.states[0].supply[1][PieceType.MOSQUITO], 1);
  assert.equal(replay.states[0].supply[1][PieceType.LADYBUG], undefined);
});

test('a stalemate draw (forced passes) replays to the same board', () => {
  const { state, log } = record([...OPENING, { type: ActionType.PASS }]);
  const live = { ...state, winner: 'DRAW' };
  assert.ok(replayForGame(log, live));
});

test('sameBoard compares players and types per stack layer, not ids', () => {
  const a = new Map([['0,0', [{ player: 1, type: 'ANT', id: 'wA1' }, { player: 2, type: 'BEETLE' }]]]);
  const b = new Map([['0,0', [{ player: 1, type: 'ANT' }, { player: 2, type: 'BEETLE', id: 'bB1' }]]]);
  assert.ok(sameBoard(a, b));
  assert.ok(!sameBoard(a, new Map([['0,0', [{ player: 1, type: 'ANT' }]]])));
  assert.ok(!sameBoard(a, new Map([['1,0', a.get('0,0')]])));
  assert.ok(!sameBoard(new Map([['0,0', [{ player: 1, type: 'ANT' }]]]), new Map([['0,0', [{ player: 2, type: 'ANT' }]]])));
});

test('plyInfo: moved piece type, owner and text', () => {
  const { log } = record(OPENING);
  assert.deepEqual(plyInfo(log[0]), { player: 1, owner: 1, type: PieceType.ANT, text: 'wA1', pass: false });
  assert.equal(plyInfo(log[1]).type, PieceType.SPIDER);
  assert.equal(plyInfo(log[4]).type, PieceType.QUEEN, 'a move names the piece moved');
  assert.deepEqual(plyInfo({ notation: 'pass', player: 2, turnNumber: 7, action: { type: 'PASS' } }),
    { player: 2, owner: null, type: null, text: 'PASS', pass: true });
});

test('plyInfo: a throw names the thrown piece and its owner, not the thrower', () => {
  let throws = 0;
  for (const seed of [3, 5, 7, 11, 13, 17, 19, 23]) {
    const { settings, actions } = randomGame(80, seed);
    let state = createGame(settings);
    for (const a of actions) {
      const info = plyInfo(logEntry(state, a));
      if (a.type === ActionType.THROW) {
        throws++;
        const thrown = state.board.get(a.from).at(-1);
        assert.equal(info.owner, thrown.player, `seed ${seed}: owner of the thrown piece`);
        assert.equal(info.type, thrown.type);
        assert.equal(info.player, state.turn, 'player is still the thrower');
      } else if (a.type !== ActionType.PASS) {
        assert.equal(info.owner, state.turn);
      }
      state = applyAction(state, a);
    }
  }
  assert.ok(throws > 0, 'the sample games include throws');
});

test('movesText: one numbered ply per line, with an optional title', () => {
  const { log } = record(OPENING.slice(0, 3));
  assert.equal(movesText(log), `1. ${log[0].notation}\n2. ${log[1].notation}\n3. ${log[2].notation}`);
  assert.equal(movesText(log, { title: 'HIVE' }).split('\n')[0], 'HIVE');
  assert.equal(movesText([]), '');
});

test('notationHTML: ids in their owner\'s colour, direction markers inked with their reference id', () => {
  assert.equal(notationHTML('wA1'), '<b class="nid p1">wA1</b>');
  assert.equal(notationHTML('bL bA1/'), '<b class="nid p2">bL</b> <b class="nid p2">bA1<i class="nmk">/</i></b>');
  assert.equal(notationHTML('wB1 \\bQ'), '<b class="nid p1">wB1</b> <b class="nid p2"><i class="nmk">\\</i>bQ</b>');
  assert.equal(notationHTML('bG2 -wS1'), '<b class="nid p2">bG2</b> <b class="nid p1"><i class="nmk">-</i>wS1</b>');
  assert.equal(notationHTML('wB1 bG2'), '<b class="nid p1">wB1</b> <b class="nid p2">bG2</b>', 'a climb has no marker');
  assert.equal(notationHTML('PASS'), 'PASS');
  assert.equal(notationHTML('<x>'), '&#60;x&#62;', 'escaped');
});
