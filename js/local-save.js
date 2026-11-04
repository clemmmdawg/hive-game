// local-save.js — Serialize a pass-and-play game (with undo history) for localStorage.

import { PieceType, serializeState, deserializeState } from './game.js';

export const MAX_UNDO = 80;
const VERSION = 1;
const PIECES  = new Set(Object.values(PieceType));

/** @returns {string} JSON for localStorage */
export function encodeLocalSave({ settings, state, history }) {
  return JSON.stringify({
    v:        VERSION,
    settings,
    state:    serializeState(state),
    history:  history.slice(-MAX_UNDO).map(serializeState),
    savedAt:  Date.now(),
  });
}

/**
 * @param {string|null} json
 * @returns {{ settings, state, history, savedAt }|null} null when missing, corrupt or finished
 */
export function decodeLocalSave(json) {
  try {
    const data = JSON.parse(json);
    if (data?.v !== VERSION || !data.state || !Array.isArray(data.history)) return null;
    const state = deserializeState(data.state);
    if (state.winner || !isValidBoard(state.board)) return null;
    return {
      settings: data.settings ?? {},
      state,
      history:  data.history.slice(-MAX_UNDO).map(deserializeState),
      savedAt:  data.savedAt ?? null,
    };
  } catch {
    return null;
  }
}

function isValidBoard(board) {
  for (const [key, stack] of board) {
    if (!/^-?\d+,-?\d+$/.test(key) || !Array.isArray(stack) || !stack.length) return false;
    if (!stack.every(p => (p.player === 1 || p.player === 2) && PIECES.has(p.type))) return false;
  }
  return true;
}
