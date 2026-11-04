// replay.js — Pure: rebuild a game's positions from its move log (game review / replay). Imports only game.js.
//
// A move log (app.js `moveLog`) holds { notation, player, turnNumber, action } per ply. Re-applying the
// actions from createGame(settings) gives every position of the game. A log that does not reproduce the
// live game (a resumed v1 save starts with an empty log; a corrupt entry) is not replayable: callers get
// null rather than a sequence of wrong positions.

import { createGame, applyAction, ActionType, PieceType } from './game.js';

/**
 * Every position of a game, by re-applying `actions` from createGame(settings).
 * states[0] is the empty opening board; states[i] is the position after the i-th action.
 * The states are fresh copies (applyAction never mutates), so a replay cannot reach the live game.
 * @returns {{ states: object[], index: number, readonly state: object, readonly atEnd: boolean,
 *             step(delta: number): number, seek(i: number): number }}
 */
export function createReplay(settings, actions, { index = 0 } = {}) {
  const states = [createGame(settings)];
  for (const action of actions) states.push(applyAction(states.at(-1), action));
  const clamp = i => Math.max(0, Math.min(states.length - 1, Math.round(Number(i) || 0)));
  return {
    states,
    index: clamp(index),
    get state() { return states[this.index]; },
    get atEnd() { return this.index === states.length - 1; },
    step(delta) { this.index = clamp(this.index + delta); return this.index; },
    seek(i) { this.index = clamp(i); return this.index; },
  };
}

/** Same pieces on the same hexes, layer by layer (player + type; ids are ignored). */
export function sameBoard(a, b) {
  if (a.size !== b.size) return false;
  for (const [key, stack] of a) {
    const other = b.get(key);
    if (!other || other.length !== stack.length) return false;
    if (stack.some((p, i) => p.player !== other[i].player || p.type !== other[i].type)) return false;
  }
  return true;
}

/**
 * The replay of `moveLog` if it reproduces `liveState` (same board, same turn count), else null.
 * Uses the live game's own settings (expansions decide the supply).
 */
export function replayForGame(moveLog, liveState, { index } = {}) {
  if (!Array.isArray(moveLog) || !liveState) return null;
  if (moveLog.some(entry => !entry?.action?.type)) return null;
  let replay;
  try {
    replay = createReplay(liveState.settings, moveLog.map(entry => entry.action), { index });
  } catch {
    return null; // an action that does not fit the position (e.g. moves from an empty hex)
  }
  const last = replay.states.at(-1);
  return sameBoard(last.board, liveState.board) && last.turnNumber === liveState.turnNumber ? replay : null;
}

const TYPE_BY_LETTER = {
  Q: PieceType.QUEEN, B: PieceType.BEETLE, G: PieceType.GRASSHOPPER, A: PieceType.ANT,
  S: PieceType.SPIDER, M: PieceType.MOSQUITO, L: PieceType.LADYBUG, P: PieceType.PILLBUG,
};

/**
 * Display data for one log entry: who moved, which piece (the first notation id names it, so it works
 * for any log, replayable or not), and the text to show.
 * @returns {{ player: 1|2, type: string|null, text: string, pass: boolean }}
 */
export function plyInfo(entry) {
  const pass = entry.action?.type === ActionType.PASS || entry.notation === 'pass';
  const letter = /^[wb]([QBGASMLP])/.exec(entry.notation ?? '')?.[1];
  return {
    player: entry.player,
    type:   pass ? null : TYPE_BY_LETTER[letter] ?? entry.action?.pieceType ?? null,
    text:   pass ? 'PASS' : entry.notation,
    pass,
  };
}

/** Plain-text game record: an optional title line, then '1. wA1', '2. bS1 wA1-', … one ply per line. */
export function movesText(moveLog, { title = '' } = {}) {
  const lines = moveLog.map((entry, i) => `${entry.turnNumber ?? i + 1}. ${entry.notation}`);
  return (title ? [title, ...lines] : lines).join('\n');
}
