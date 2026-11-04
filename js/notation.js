// notation.js — Pure BoardSpace/Mzinga-style move notation. Imports only game.js (server-safe).
//
// Identity: applyAction (game.js) stamps each piece with `id` ('wA1', 'bQ', ...) at placement, numbered per
// player per type by placement order; the id travels with the piece through MOVE/THROW (pieces are copied
// with spread). States without ids (old saves, hand-built boards) get ids assigned deterministically by
// pieceIds(): hexes in sorted key order, bottom-to-top, numbering continues after any ids already present.

import { PieceType, ActionType, parseKey, hexKey, neighbors, applyAction, pieceId } from './game.js';

/**
 * Marker for where the moved piece sits relative to the reference piece, indexed by the direction
 * (DIRS index, clockwise from E) from reference to destination. DIRS[0] -> 'X-', then a fixed
 * 30-degree rotation of the pointy-top convention: before the reference = left side, after = right.
 */
export const MARKERS = ['X-', 'X\\', '/X', '-X', '\\X', 'X/'];

const OPPOSITE = i => (i + 3) % 6;

/** @returns {Map<string, string[]>} hexKey -> id per stack layer (bottom first). */
export function pieceIds(state) {
  const used = new Set();
  for (const stack of state.board.values()) for (const p of stack) if (p.id) used.add(p.id);
  const next = {};
  const out = new Map();
  const keys = [...state.board.keys()].sort();
  const hasMissing = keys.some(k => state.board.get(k).some(p => !p.id));
  for (const k of keys) {
    out.set(k, state.board.get(k).map(p => {
      if (p.id) return p.id;
      if (!hasMissing) return null;
      const tag = `${p.player}${p.type}`;
      let n = next[tag] ?? 0, id;
      do { id = pieceId(p.player, p.type, ++n); } while (used.has(id) && n < 99);
      next[tag] = n; used.add(id);
      return id;
    }));
  }
  return out;
}

/** Notation for `action` taken in `prevState`, e.g. 'wA1', 'bS1 wA1-', 'wB1 bQ', 'pass'. */
export function toNotation(prevState, action) {
  if (action.type === ActionType.PASS) return 'pass';
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
