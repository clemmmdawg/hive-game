import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLOCK_PRESETS, CLOCK_OFF, presetSettings, presetIdOf, normalizeClockSettings,
  createClock, startTurn, endTurn, remainingFor, isFlagged, pause, resume, flag,
  rebaseClock, restoreClock, formatClock, LOW_TIME_MS, announcedPass,
} from '../js/clock.js';

const MIN = 60_000;
const s10p5 = { enabled: true, type: 'FISCHER', time: 10 * MIN, increment: 5000 };

test('presets are exactly OFF / 5+0 / 10+5 / 15+10 / 30+0 (minutes + seconds)', () => {
  assert.deepEqual(CLOCK_PRESETS.map(p => p.id), ['OFF', '5+0', '10+5', '15+10', '30+0']);
  assert.deepEqual(presetSettings('OFF'), { enabled: false });
  assert.deepEqual(presetSettings('5+0'),   { enabled: true, type: 'FISCHER', time: 5 * MIN,  increment: 0 });
  assert.deepEqual(presetSettings('10+5'),  { enabled: true, type: 'FISCHER', time: 10 * MIN, increment: 5000 });
  assert.deepEqual(presetSettings('15+10'), { enabled: true, type: 'FISCHER', time: 15 * MIN, increment: 10_000 });
  assert.deepEqual(presetSettings('30+0'),  { enabled: true, type: 'FISCHER', time: 30 * MIN, increment: 0 });
  assert.deepEqual(presetSettings('nope'), CLOCK_OFF);
  assert.equal(presetIdOf(s10p5), '10+5');
  assert.equal(presetIdOf({ enabled: false }), 'OFF');
  assert.equal(presetIdOf(undefined), 'OFF');
});

test('normalizeClockSettings accepts only the presets', () => {
  assert.deepEqual(normalizeClockSettings(s10p5), s10p5);
  assert.deepEqual(normalizeClockSettings({ enabled: true, time: 10 * MIN, increment: 5000 }), s10p5); // type implied
  for (const bad of [
    null, 'x', 42, {}, { enabled: false, time: 5 * MIN },
    { enabled: true, type: 'FISCHER', time: 1, increment: 0 },
    { enabled: true, type: 'FISCHER', time: 10 * MIN, increment: 4000 },
    { enabled: true, type: 'BRONSTEIN', time: 10 * MIN, increment: 5000 },
    { enabled: true, type: 'FISCHER', time: '600000', increment: '5000' },
  ]) {
    assert.deepEqual(normalizeClockSettings(bad), { enabled: false }, JSON.stringify(bad));
  }
});

test('createClock: null when off; both sides get the full time, P1 to move, not yet running', () => {
  assert.equal(createClock({ enabled: false }), null);
  assert.equal(createClock(undefined), null);
  const c = createClock(s10p5);
  assert.deepEqual(c, { remaining: { 1: 10 * MIN, 2: 10 * MIN }, increment: 5000, active: 1, running: false, turnStartedAt: null });
  assert.equal(remainingFor(c, 1, 999_999), 10 * MIN, 'a stopped clock does not count down');
});

test('startTurn runs the side to move; remainingFor counts down only that side', () => {
  const c = startTurn(createClock(s10p5), 1000);
  assert.equal(c.running, true);
  assert.equal(c.turnStartedAt, 1000);
  assert.equal(remainingFor(c, 1, 4000), 10 * MIN - 3000);
  assert.equal(remainingFor(c, 2, 4000), 10 * MIN);
  assert.equal(remainingFor(c, 1, 1000 + 11 * MIN), 0, 'never negative');
});

test('endTurn deducts elapsed time, adds the increment and hands the clock over (immutably)', () => {
  const c0 = startTurn(createClock(s10p5), 0);
  const c1 = endTurn(c0, 1, 7000);
  assert.notEqual(c1, c0);
  assert.equal(c0.remaining[1], 10 * MIN, 'input untouched');
  assert.equal(c1.remaining[1], 10 * MIN - 7000 + 5000);
  assert.equal(c1.active, 2);
  assert.equal(c1.turnStartedAt, 7000);
  assert.equal(c1.running, true);
  assert.equal(remainingFor(c1, 2, 9000), 10 * MIN - 2000);
  const c2 = endTurn(c1, 2, 10_000);
  assert.equal(c2.remaining[2], 10 * MIN - 3000 + 5000);
  assert.equal(c2.active, 1);
});

test('endTurn on a flagged side keeps it at zero (no increment rescue)', () => {
  const c = endTurn(startTurn(createClock(presetSettings('5+0')), 0), 1, 6 * MIN);
  assert.equal(c.remaining[1], 0);
  const inc = endTurn(startTurn(createClock(s10p5), 0), 1, 11 * MIN);
  assert.equal(inc.remaining[1], 0);
});

test('endTurn while paused adds the increment without deducting anything', () => {
  const c = endTurn(createClock(s10p5), 1, 50_000);
  assert.equal(c.remaining[1], 10 * MIN + 5000);
  assert.equal(c.running, false);
  assert.equal(c.active, 2);
});

test('isFlagged once the side to move reaches zero', () => {
  const c = startTurn(createClock(presetSettings('5+0')), 0);
  assert.equal(isFlagged(c, 1, 5 * MIN - 1), false);
  assert.equal(isFlagged(c, 1, 5 * MIN), true);
  assert.equal(isFlagged(c, 2, 99 * MIN), false, 'the waiting side never flags');
  assert.equal(isFlagged(null, 1, 0), false);
});

test('pause folds elapsed time in; resume restarts from now', () => {
  const c = startTurn(createClock(s10p5), 0);
  const p = pause(c, 4000);
  assert.equal(p.running, false);
  assert.equal(p.turnStartedAt, null);
  assert.equal(p.remaining[1], 10 * MIN - 4000);
  assert.equal(remainingFor(p, 1, 60_000), 10 * MIN - 4000, 'frozen while paused');
  assert.equal(pause(p, 9000), p, 'pausing a paused clock is a no-op');
  const r = resume(p, 60_000);
  assert.equal(r.running, true);
  assert.equal(remainingFor(r, 1, 61_000), 10 * MIN - 5000);
  assert.equal(resume(r, 70_000), r, 'resuming a running clock is a no-op');
});

test('flag zeroes the side to move and stops the clock', () => {
  const f = flag(startTurn(createClock(presetSettings('5+0')), 0), 5 * MIN + 30);
  assert.equal(f.running, false);
  assert.equal(f.remaining[1], 0);
  assert.equal(f.remaining[2], 5 * MIN);
});

test('rebaseClock moves a server clock onto the local time base (skew-corrected)', () => {
  const server = startTurn(createClock(s10p5), 1_000_000); // server epoch
  // The server sent it at serverNow 1_003_000 (3 s into the turn); our Date.now() reads 50_000.
  const local = rebaseClock(server, 1_003_000, 50_000);
  assert.equal(remainingFor(local, 1, 50_000), 10 * MIN - 3000);
  assert.equal(remainingFor(local, 1, 52_000), 10 * MIN - 5000);
  const paused = pause(server, 1_002_000);
  assert.equal(rebaseClock(paused, 1_003_000, 50_000).turnStartedAt, null);
  assert.equal(rebaseClock(null, 0, 0), null);
});

test('restoreClock validates a saved clock and falls back to a fresh one (or null when off)', () => {
  const saved = JSON.parse(JSON.stringify(pause(startTurn(createClock(s10p5), 0), 12_000)));
  const r = restoreClock(saved, s10p5);
  assert.equal(r.remaining[1], 10 * MIN - 12_000);
  assert.equal(r.running, false, 'restored paused');
  assert.equal(r.increment, 5000);
  assert.deepEqual(restoreClock({ remaining: { 1: 'x' } }, s10p5), createClock(s10p5));
  assert.deepEqual(restoreClock(undefined, s10p5), createClock(s10p5));
  assert.equal(restoreClock(saved, { enabled: false }), null);
  // A running clock comes back paused with the elapsed time it had when saved folded in only.
  const running = JSON.parse(JSON.stringify(startTurn(createClock(s10p5), 0)));
  assert.equal(restoreClock(running, s10p5).running, false);
});

test('formatClock: m:ss over 10 s (minutes zero-padded), ss.t below', () => {
  assert.equal(formatClock(30 * MIN), '30:00');
  assert.equal(formatClock(5 * MIN), '05:00');
  assert.equal(formatClock(4 * MIN + 59_999), '04:59');
  assert.equal(formatClock(10_000), '00:10');
  assert.equal(formatClock(9_999), '09.9');
  assert.equal(formatClock(1_250), '01.2');
  assert.equal(formatClock(40), '00.0');
  assert.equal(formatClock(0), '00.0');
  assert.equal(formatClock(-50), '00.0');
  assert.equal(LOW_TIME_MS, 10_000);
});

test('announcedPass: a forced pass is charged up to the banner, the next side starts when it is applied', () => {
  const c = startTurn(createClock(s10p5), 0);
  const p = announcedPass(c, 1, 3000, 4700); // banner at 3 s, pass applied at 4.7 s
  assert.equal(p.remaining[1], 10 * MIN - 3000 + 5000, 'the 1.7 s banner is not charged to the stuck side');
  assert.equal(p.active, 2);
  assert.equal(remainingFor(p, 2, 4700), 10 * MIN, 'nor to the next side');
  const held = announcedPass(pause(c, 3500), 1, 3000, 4700);
  assert.equal(held.running, false, 'a clock held meanwhile stays held');
  assert.equal(announcedPass(null, 1, 0, 0), null);
});
