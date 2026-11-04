// clock.js — Fischer game clock. Pure: no DOM, no timers, every function takes `now` (epoch ms).
// Server-importable (server/server.js keeps one per room); app.js keeps one for local games.
//
// Settings (settings.clock): { enabled: false } or { enabled: true, type: 'FISCHER', time: ms, increment: ms },
// limited to CLOCK_PRESETS. A clock (null when off):
//   { remaining: {1: ms, 2: ms}, increment: ms, active: 1|2, running: bool, turnStartedAt: epoch ms|null }
// `remaining[active]` excludes the time spent since `turnStartedAt` while running. Clocks are immutable.

export const CLOCK_OFF = Object.freeze({ enabled: false });
export const LOW_TIME_MS = 10_000; // red pulse + tick, and tenths on the display

const MIN = 60_000;
/** Minutes per side + seconds added after each move. */
export const CLOCK_PRESETS = Object.freeze([
  { id: 'OFF',   label: 'OFF',   time: 0,        increment: 0 },
  { id: '5+0',   label: '5+0',   time: 5 * MIN,  increment: 0 },
  { id: '10+5',  label: '10+5',  time: 10 * MIN, increment: 5_000 },
  { id: '15+10', label: '15+10', time: 15 * MIN, increment: 10_000 },
  { id: '30+0',  label: '30+0',  time: 30 * MIN, increment: 0 },
].map(Object.freeze));

/** settings.clock for a preset id ('OFF' or unknown → clock off). */
export function presetSettings(id) {
  const p = CLOCK_PRESETS.find(x => x.id === id);
  if (!p || !p.time) return { ...CLOCK_OFF };
  return { enabled: true, type: 'FISCHER', time: p.time, increment: p.increment };
}

/** The preset id a settings.clock matches ('OFF' when off or not a preset). */
export function presetIdOf(clock) {
  if (!clock?.enabled) return 'OFF';
  return CLOCK_PRESETS.find(p => p.time && p.time === clock.time && p.increment === clock.increment)?.id ?? 'OFF';
}

/** Only an exact preset is accepted; anything else (wrong type, odd numbers, strings) is clock off. */
export function normalizeClockSettings(raw) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return { ...CLOCK_OFF };
  if (raw.type !== undefined && raw.type !== 'FISCHER') return { ...CLOCK_OFF };
  if (typeof raw.time !== 'number' || typeof raw.increment !== 'number') return { ...CLOCK_OFF };
  return presetSettings(presetIdOf(raw));
}

/** A fresh clock for settings.clock, stopped with player 1 to move; null when the clock is off. */
export function createClock(settings) {
  if (!settings?.enabled || !(settings.time > 0)) return null;
  return {
    remaining: { 1: settings.time, 2: settings.time },
    increment: Math.max(0, settings.increment || 0),
    active: 1,
    running: false,
    turnStartedAt: null,
  };
}

const elapsed = (clock, now) => (clock.running && clock.turnStartedAt != null ? Math.max(0, now - clock.turnStartedAt) : 0);
const other = p => (p === 1 ? 2 : 1);

/** Start (or restart) the active side's clock from `now`. */
export function startTurn(clock, now) {
  if (!clock) return clock;
  return { ...clock, running: true, turnStartedAt: now };
}

/** Time `player` has left at `now` (never negative). */
export function remainingFor(clock, player, now) {
  if (!clock) return Infinity;
  const left = clock.remaining[player] - (player === clock.active ? elapsed(clock, now) : 0);
  return Math.max(0, left);
}

export function isFlagged(clock, player, now) {
  return !!clock && player === clock.active && remainingFor(clock, player, now) <= 0;
}

/**
 * `player` completed a move at `now`: their elapsed time is deducted, the increment added (not to a
 * side already at zero), and the other side's clock starts (if the clock was running).
 */
export function endTurn(clock, player, now) {
  if (!clock) return clock;
  const left = remainingFor(clock, player, now);
  const remaining = { ...clock.remaining, [player]: left > 0 ? left + clock.increment : 0 };
  return { ...clock, remaining, active: other(player), turnStartedAt: clock.running ? now : null };
}

/**
 * A forced pass announced at `announcedAt` and applied at `now`: the stuck side's turn ends at the
 * announcement, the next side's starts when the pass is applied (the banner in between is nobody's time).
 */
export function announcedPass(clock, player, announcedAt, now) {
  const next = endTurn(clock, player, announcedAt);
  return next?.running ? { ...next, turnStartedAt: now } : next;
}

/** Stop the clock, folding the time spent so far into the active side's remaining. */
export function pause(clock, now) {
  if (!clock || !clock.running) return clock;
  return {
    ...clock,
    remaining: { ...clock.remaining, [clock.active]: remainingFor(clock, clock.active, now) },
    running: false,
    turnStartedAt: null,
  };
}

export function resume(clock, now) {
  if (!clock || clock.running) return clock;
  return { ...clock, running: true, turnStartedAt: now };
}

/** The side to move ran out: zero it and stop. */
export function flag(clock, now) {
  const stopped = pause(clock, now);
  return stopped && { ...stopped, remaining: { ...stopped.remaining, [stopped.active]: 0 } };
}

/**
 * Re-express a clock received from the server (whose `turnStartedAt` is in server time, sent at
 * `serverNow`) in local time (`localNow` = Date.now() on arrival), so local clock skew cancels out.
 */
export function rebaseClock(clock, serverNow, localNow) {
  if (!clock) return null;
  if (!clock.running || clock.turnStartedAt == null) return { ...clock, turnStartedAt: null };
  return { ...clock, turnStartedAt: clock.turnStartedAt - serverNow + localNow };
}

const validMs = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * A clock loaded from storage, always paused (the local game resumes it once it is on screen).
 * Invalid data → a fresh clock for `settings`; clock off → null.
 */
export function restoreClock(raw, settings) {
  const fresh = createClock(settings);
  if (!fresh) return null;
  const rem = raw?.remaining;
  if (!rem || !validMs(rem[1]) || !validMs(rem[2]) || (raw.active !== 1 && raw.active !== 2)) return fresh;
  return { ...fresh, remaining: { 1: rem[1], 2: rem[2] }, active: raw.active, running: false, turnStartedAt: null };
}

const pad2 = n => String(n).padStart(2, '0');

/** "05:00" (mm:ss) at 10 s and above; "09.4" (ss.t, tenths floored) below. */
export function formatClock(ms) {
  const t = Math.max(0, ms);
  if (t < LOW_TIME_MS) {
    const tenths = Math.floor(t / 100);
    return `${pad2(Math.floor(tenths / 10))}.${tenths % 10}`;
  }
  const s = Math.floor(t / 1000);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}
