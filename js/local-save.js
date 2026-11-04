// local-save.js — Serialize a pass-and-play game (with undo history) for localStorage.

import { PieceType, serializeState, deserializeState } from './game.js';
import { normalizeClockSettings, restoreClock } from './clock.js';

export const MAX_UNDO = 80;
// v3 adds the game clock (+ a clock snapshot per undo step); v1 (no move log) and v2 (no clock) still
// load, as clock-off games.
const VERSION = 3;
const PIECES  = new Set(Object.values(PieceType));

/**
 * @param {{settings, state, history, moveLog?, clock?, clockHistory?}} game
 *   clock: js/clock.js clock (null when off; pause it first so the save holds the time spent so far);
 *   clockHistory: the clock as it was before each history entry (parallel to `history`)
 * @returns {string} JSON for localStorage
 */
export function encodeLocalSave({ settings, state, history, moveLog = [], clock = null, clockHistory = [] }) {
  const kept = history.slice(-MAX_UNDO);
  return JSON.stringify({
    v:        VERSION,
    settings,
    state:    serializeState(state),
    history:  kept.map(serializeState),
    moveLog,
    clock,
    clockHistory: clockHistory.length === history.length ? clockHistory.slice(-MAX_UNDO) : kept.map(() => null),
    savedAt:  Date.now(),
  });
}

/**
 * @param {string|null} json
 * @returns {{ settings, state, history, moveLog, clock, clockHistory, savedAt }|null} null when missing,
 *   corrupt or finished. `clock` is paused (or null: clock off, or a pre-v3 save); `clockHistory` has
 *   one entry (clock or null) per history entry.
 */
export function decodeLocalSave(json) {
  try {
    const data = JSON.parse(json);
    if (![1, 2, VERSION].includes(data?.v) || !data.state || !Array.isArray(data.history)) return null;
    let state = deserializeState(data.state);
    if (state.winner || !isValidBoard(state.board)) return null;
    let history = data.history.slice(-MAX_UNDO).map(deserializeState);
    let settings = data.settings ?? {};
    let clock = null;
    let clockHistory = history.map(() => null);
    if (data.v === VERSION) {
      const clockSettings = normalizeClockSettings(state.settings?.clock);
      clock = restoreClock(data.clock, clockSettings);
      const snaps = Array.isArray(data.clockHistory) && data.clockHistory.length === history.length ? data.clockHistory : null;
      if (clock && snaps) clockHistory = snaps.map(c => (c ? restoreClock(c, clockSettings) : null));
    }
    if (!clock && (settings.clock?.enabled || state.settings?.clock?.enabled)) {
      // A timed game without a usable clock (a pre-v3 save): it continues untimed, and says so
      // everywhere (rematch reuses the settings).
      const off = s => ({ ...s, settings: { ...s.settings, clock: { enabled: false } } });
      settings = { ...settings, clock: { enabled: false } };
      state = off(state);
      history = history.map(off);
    }
    return {
      settings,
      state,
      history,
      moveLog:  data.v >= 2 && Array.isArray(data.moveLog) ? data.moveLog : [],
      clock,
      clockHistory,
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
