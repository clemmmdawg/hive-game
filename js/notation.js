// notation.js — Pure BoardSpace/Mzinga-style move notation. Imports only game.js (server-safe).
//
// Identity: applyAction (game.js) stamps each piece with `id` ('wA1', 'bQ', ...) at placement, numbered per
// player per type by placement order; the id travels with the piece through MOVE/THROW (pieces are copied
// with spread). States without ids (old saves, hand-built boards) get ids from game.js stampPieceIds(),
// which deserializeState applies once at load so prev/after states can never number differently.

import { ActionType, parseKey, hexKey, neighbors, applyAction, pieceId, stampPieceIds } from './game.js';

/**
 * Marker for where the moved piece sits relative to the reference piece, indexed by the direction
 * (DIRS index, clockwise from E) from reference to destination. DIRS[0] -> 'X-', then a fixed
 * 30-degree rotation of the pointy-top convention: before the reference = left side, after = right.
 */
export const MARKERS = ['X-', 'X\\', '/X', '-X', '\\X', 'X/'];

const OPPOSITE = i => (i + 3) % 6;

/** @returns {Map<string, string[]>} hexKey -> id per stack layer (bottom first); id-less pieces are stamped first. */
export function pieceIds(state) {
  const out = new Map();
  for (const [k, stack] of stampPieceIds(state).board) out.set(k, stack.map(p => p.id));
  return out;
}

/** Notation for `action` taken in `prevState`, e.g. 'wA1', 'bS1 wA1-', 'wB1 bQ', 'pass'. */
export function toNotation(prevState, action) {
  if (action.type === ActionType.PASS) return 'pass';
  prevState = stampPieceIds(prevState); // afterState below inherits the same ids
  const ids = pieceIds(prevState);
  let id, to = action.to;
  if (action.type === ActionType.PLACE) {
    const n = [...prevState.board.values()].flat()
      .filter(p => p.player === prevState.turn && p.type === action.pieceType).length + 1;
    id = pieceId(prevState.turn, action.pieceType, n);
  } else {
    id = ids.get(action.from).at(-1);
  }
  if (prevState.board.has(to)) return `${id} ${ids.get(to).at(-1)}`;

  // Neighbours of the destination after the action, so the moving piece's old hex doesn't count.
  const afterState = applyAction(prevState, action);
  const after = afterState.board;
  const { q, r } = parseKey(to);
  const nb = neighbors(q, r);
  const i = nb.findIndex(n => after.has(hexKey(n.q, n.r)));
  if (i < 0) return id;
  const refKey = hexKey(nb[i].q, nb[i].r);
  const refId = pieceIds(afterState).get(refKey).at(-1);
  const marker = MARKERS[OPPOSITE(i)];
  return `${id} ${marker.replace('X', refId)}`;
}

/**
 * One move-log entry for `action` taken in `prevState`. Keeps the action so a log can be replayed from
 * createGame(settings) by re-applying actions.
 * @returns {{ notation: string, player: 1|2, turnNumber: number, action: object }}
 */
export function logEntry(prevState, action) {
  return {
    notation:   toNotation(prevState, action),
    player:     prevState.turn,
    turnNumber: prevState.turnNumber,
    action:     { ...action },
  };
}

/**
 * Drop what one local undo takes back: the last real move plus any forced passes that followed it
 * (local passes are automatic and never get their own undo step). Returns a new array.
 */
export function undoLogEntry(moveLog) {
  const log = [...moveLog];
  while (log.length && log.pop().action.type === ActionType.PASS) { /* keep popping through passes */ }
  return log;
}
