// hints.js — Status-line copy for the HUD. Pure; no DOM.

import { getAllLegalActions } from './game.js';

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
 * @param {string|null} [ctx.winReason] 'QUEEN' | 'STALEMATE' | 'RESIGN' | null — why the game ended
 */
export function statusText({ state, phase = 'IDLE', mode = 'LOCAL', myPlayer = 1, blocker = null, throwCount = 0, pieceName = 'PIECE', winReason = null }) {
  const online = mode === 'ONLINE';

  if (state.winner === 'DRAW') {
    return winReason === 'STALEMATE' ? 'DRAW — NO MOVES LEFT' : 'DRAW — BOTH QUEENS SURROUNDED';
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
  if (online && state.turn !== myPlayer) return "OPPONENT'S TURN…";
  if (getAllLegalActions(state).mustPass) return 'NO LEGAL MOVES — YOU MUST PASS';

  if (phase === 'TRAY')  return `TAP A GREEN HEX TO PLACE ${pieceName}`;
  if (phase === 'THROW') return 'TAP A GREEN HEX TO DROP IT';
  if (phase === 'BOARD') {
    if (throwCount && !blocker) return 'MOVE TO GREEN · OR TAP AMBER TO THROW';
    if (throwCount) return 'TAP AN AMBER PIECE TO THROW IT';
    if (blocker) return BLOCKER_TEXT[blocker] ?? 'THIS PIECE CANNOT MOVE';
    return 'TAP A GREEN HEX TO MOVE';
  }

  const placed = placedCount(state.board, state.turn);
  if (placed === 0) return 'PLACE YOUR FIRST PIECE';
  if (!state.queenPlaced[state.turn]) {
    return placed === 3 ? 'PLACE YOUR QUEEN NOW — 4TH PIECE' : 'PLACE A PIECE · QUEEN BY YOUR 4TH';
  }
  return 'PLACE OR MOVE A PIECE';
}

/**
 * Map a server end reason (GAME_OVER.reason / ROOM_RESUMED.endReason) onto the
 * client's winReason. A server 'DRAW' means both queens fell together.
 * @returns {'QUEEN'|'RESIGN'|null}
 */
export function winReasonFromServer(reason) {
  if (reason === 'RESIGN') return 'RESIGN';
  if (reason === 'QUEEN' || reason === 'DRAW') return 'QUEEN';
  return null;
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

function countPieces(board) {
  let n = 0;
  for (const stack of board.values()) n += stack.length;
  return n;
}
