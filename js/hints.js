// hints.js — Status-line copy for the HUD. Pure; no DOM.

import { ActionType, getAllLegalActions, getLegalPlacements, getLegalMoves, getLegalThrows, queenPressure, positionKey, REPETITION_LIMIT } from './game.js';

const BLOCKER_TEXT = {
  NOT_YOUR_PIECE:   "THAT'S NOT YOUR PIECE",
  QUEEN_NOT_PLACED: 'PLACE YOUR QUEEN BEFORE MOVING',
  JUST_THROWN:      "JUST THROWN — IT CAN'T MOVE THIS TURN",
  ONE_HIVE:         'PINNED — MOVING IT WOULD SPLIT THE HIVE',
  NO_MOVES:         'THIS PIECE HAS NO LEGAL MOVES',
};

function placedCount(board, player) {
  let n = 0;
  for (const stack of board.values()) for (const p of stack) if (p.player === player) n++;
  return n;
}

/**
 * @param {object} ctx
 * @param {object} ctx.state        GameState
 * @param {string} [ctx.phase]      'IDLE' | 'TRAY' | 'BOARD' | 'THROW'
 * @param {string} [ctx.mode]       'LOCAL' | 'ONLINE'
 * @param {number} [ctx.myPlayer]   seat in ONLINE mode
 * @param {string|null} [ctx.blocker]  getMoveBlocker() result for the selected piece
 * @param {number} [ctx.throwCount] throwable neighbours of the selected piece
 * @param {string} [ctx.pieceName]  display name of the selected tray piece
 * @param {string|null} [ctx.winReason] 'QUEEN' | 'STALEMATE' | 'REPETITION' | 'RESIGN' | null — why the game ended
 */
export function statusText({ state, phase = 'IDLE', mode = 'LOCAL', myPlayer = 1, blocker = null, throwCount = 0, pieceName = 'PIECE', winReason = null }) {
  const online = mode === 'ONLINE';

  if (state.winner === 'DRAW') {
    if (winReason === 'STALEMATE') return 'DRAW — NO MOVES LEFT';
    if (winReason === 'REPETITION' || state.drawReason === 'REPETITION') return 'DRAW — THREEFOLD REPETITION';
    return 'DRAW — BOTH QUEENS SURROUNDED';
  }
  if (state.winner) {
    if (winReason === 'RESIGN') {
      const loser = state.winner === 1 ? 2 : 1;
      if (online) return loser === myPlayer ? 'YOU RESIGNED' : 'OPPONENT RESIGNED — YOU WIN';
      return `PLAYER ${loser} RESIGNED — PLAYER ${state.winner} WINS`;
    }
    if (online) return state.winner === myPlayer ? 'YOU WIN' : 'YOU LOSE';
    return `PLAYER ${state.winner} WINS`;
  }
  const repeated = state.positionCounts?.[positionKey(state)] === REPETITION_LIMIT - 1
    ? `REPETITION ${REPETITION_LIMIT - 1}/${REPETITION_LIMIT}` : null;
  if (online && state.turn !== myPlayer) return repeated ?? "OPPONENT'S TURN…"; // both seats see the warning
  if (getAllLegalActions(state).mustPass) return 'NO LEGAL MOVES — YOU MUST PASS';

  if (phase === 'TRAY')  return `TAP A GREEN HEX TO PLACE ${pieceName}`;
  if (phase === 'THROW') return 'TAP A GREEN HEX TO DROP IT';
  if (phase === 'BOARD') {
    if (throwCount && !blocker) return 'MOVE TO GREEN · OR TAP AMBER TO THROW';
    if (throwCount) return 'TAP AN AMBER PIECE TO THROW IT';
    if (blocker) return BLOCKER_TEXT[blocker] ?? 'THIS PIECE CANNOT MOVE';
    return 'TAP A GREEN HEX TO MOVE';
  }

  if (queenPressure(state)[state.turn] === DANGER_AT) return dangerText(state.turn, { mode, myPlayer });

  if (repeated) return repeated;

  const placed = placedCount(state.board, state.turn);
  if (placed === 0) return 'PLACE YOUR FIRST PIECE';
  if (!state.queenPlaced[state.turn]) {
    return placed === 3 ? 'PLACE YOUR QUEEN NOW — 4TH PIECE' : 'PLACE A PIECE · QUEEN BY YOUR 4TH';
  }
  return 'PLACE OR MOVE A PIECE';
}

/** Occupied sides at which a queen is one move from being surrounded. */
export const DANGER_AT = 5;

/** "P1 QUEEN IN DANGER" — online, from the viewer's side ("YOUR" / "ENEMY"). */
export function dangerText(player, { mode = 'LOCAL', myPlayer = 1 } = {}) {
  if (mode !== 'ONLINE') return `P${player} QUEEN IN DANGER`;
  return `${player === myPlayer ? 'YOUR' : 'ENEMY'} QUEEN IN DANGER`;
}

/**
 * Players whose queen has just stepped up onto DANGER_AT occupied sides between
 * two queenPressure() readings — the moment the alarm sounds. Staying there,
 * falling back, or going straight to six (the game is over) does not count;
 * without a previous reading (a resume) there is no transition.
 * @returns {Array<1|2>}
 */
export function newDangers(prev, next) {
  if (!prev || !next) return [];
  return [1, 2].filter(p => next[p] === DANGER_AT && (prev[p] ?? -1) < DANGER_AT);
}

/**
 * Map a server end reason (GAME_OVER.reason / ROOM_RESUMED.endReason) onto the
 * client's winReason. A server 'DRAW' means both queens fell together.
 * @returns {'QUEEN'|'REPETITION'|'RESIGN'|null}
 */
export function winReasonFromServer(reason) {
  if (reason === 'RESIGN') return 'RESIGN';
  if (reason === 'REPETITION') return 'REPETITION';
  if (reason === 'QUEEN' || reason === 'DRAW') return 'QUEEN';
  return null;
}

/** winReason for a game restored from the server (ROOM_RESUMED): only meaningful once it has ended. */
export function resumedWinReason(state, endReason) {
  return state?.winner ? winReasonFromServer(endReason) : null;
}

/** Label for the HUD turn chip: whose turn it is, or the result once the game is over. */
export function turnChipText({ state, mode = 'LOCAL', myPlayer = 1 }) {
  const online = mode === 'ONLINE';
  if (state.winner === 'DRAW') return 'DRAW';
  if (state.winner) {
    if (online) return state.winner === myPlayer ? 'YOU WIN' : 'YOU LOSE';
    return `P${state.winner} WINS`;
  }
  return online ? (state.turn === myPlayer ? 'YOU' : 'OPP') : `P${state.turn}`;
}

/**
 * Turn banner after an online reconnect (ROOM_RESUMED): whose move it is now.
 * Colour is the mover's (`p1`/`p2`), or `gold` when you have no legal move and must tap PASS.
 * @returns {{text:string, color:string}|null} null once the game is over (the result card speaks)
 */
export function resumeBanner({ state, myPlayer, mustPass = false }) {
  if (state.winner) return null;
  if (state.turn !== myPlayer) return { text: "OPPONENT'S TURN", color: `p${state.turn}` };
  return mustPass ? { text: 'NO MOVES — TAP PASS', color: 'gold' } : { text: 'YOUR TURN', color: `p${state.turn}` };
}

/**
 * Work out what changed between two snapshots so the board can mark it.
 * Online play only receives snapshots, so the source hex is found by diffing.
 * @returns {{ from: string|null, to: string, player: 1|2 }|null} null when nothing moved (e.g. a pass)
 */
export function describeLastMove(prev, next) {
  if (!next?.lastMovedHex) return null;
  if (!prev) return { from: null, to: next.lastMovedHex, player: next.turn === 1 ? 2 : 1 };

  let from = null;
  for (const [key, stack] of prev.board) {
    if ((next.board.get(key)?.length ?? 0) < stack.length) from = key;
  }
  const placed = countPieces(next.board) > countPieces(prev.board);
  if (!from && !placed) return null;
  return { from, to: next.lastMovedHex, player: prev.turn };
}

/**
 * The action that turned `prev` into `next`, recovered from the two snapshots
 * (online play only receives snapshots; the board animates from this). Only a
 * single legal ply is recognised: anything else — a pass, a resume, an undo,
 * snapshots further apart — gives null.
 * @returns {{type:'PLACE', pieceType, to}|{type:'MOVE', from, to}|{type:'THROW', pillbugHex, from, to}|null}
 */
export function inferAction(prev, next) {
  if (!prev || !next || next.turnNumber !== prev.turnNumber + 1) return null;
  const lm = describeLastMove(prev, next);
  if (!lm) return null;
  const { from, to } = lm;

  if (from === null) {
    const pieceType = next.board.get(to)?.at(-1)?.type;
    return pieceType && getLegalPlacements(prev, pieceType).includes(to)
      ? { type: ActionType.PLACE, pieceType, to } : null;
  }
  if (next.pillbugThrewHex === to) {
    const t = getLegalThrows(prev).find(t => t.from === from && t.to === to);
    return t ? { type: ActionType.THROW, pillbugHex: t.pillbugHex, from, to } : null;
  }
  return getLegalMoves(prev, from).includes(to) ? { type: ActionType.MOVE, from, to } : null;
}

function countPieces(board) {
  let n = 0;
  for (const stack of board.values()) n += stack.length;
  return n;
}
