import test from 'node:test';
import assert from 'node:assert/strict';

// audio.js reads the persisted mute flag at import: give it a storage first.
const store = new Map();
globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: k => store.delete(k),
};
const { sfx, SOUND_NAMES, softClip, CLIP_CEILING } = await import('../js/audio.js');

// ── A minimal fake Web Audio graph that records what gets built ──────────────

function fakeParam(value = 0) {
  return {
    value,
    setValueAtTime() { return this; },
    linearRampToValueAtTime() { return this; },
    exponentialRampToValueAtTime() { return this; },
    setTargetAtTime() { return this; },
    cancelScheduledValues() { return this; },
  };
}

function fakeContext() {
  const ctx = {
    currentTime: 10,
    sampleRate: 48000,
    state: 'running',
    destination: { connect() {} },
    nodes: [],
    stops: [],            // absolute times at which sources were scheduled to stop
    resumed: 0,
    resume() { this.resumed++; this.state = 'running'; return Promise.resolve(); },
  };
  const node = (kind, extra = {}) => {
    const n = { kind, connect(dst) { return dst; }, disconnect() {}, ...extra };
    ctx.nodes.push(n);
    return n;
  };
  const source = (kind, extra) => node(kind, {
    start() {}, stop(t) { ctx.stops.push(t); }, onended: null, ...extra,
  });
  ctx.createGain = () => node('gain', { gain: fakeParam(1) });
  ctx.createBiquadFilter = () => node('filter', { type: 'lowpass', frequency: fakeParam(350), Q: fakeParam(1), gain: fakeParam(0) });
  ctx.createWaveShaper = () => node('shaper', { curve: null, oversample: 'none' });
  ctx.createStereoPanner = () => node('panner', { pan: fakeParam() });
  ctx.createDelay = () => node('delay', { delayTime: fakeParam() });
  ctx.createConvolver = () => node('convolver', { buffer: null });
  ctx.createOscillator = () => source('osc', { type: 'sine', frequency: fakeParam(440), detune: fakeParam() });
  ctx.createBufferSource = () => source('buffer', { buffer: null, playbackRate: fakeParam(1), loop: false });
  ctx.createBuffer = (channels, length, sampleRate) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate, getChannelData: c => data[c] };
  };
  return ctx;
}

/** Fresh sfx state: a new fake context factory and vibrate spy for every test. */
function setup({ muted = false } = {}) {
  const made = [];
  const buzz = [];
  sfx._reset();
  sfx._setContextFactory(() => { const c = fakeContext(); made.push(c); return c; });
  sfx._setVibrate(pattern => buzz.push(pattern));
  sfx.setMuted(muted);
  return { made, buzz, ctx: () => made[0] };
}

const sourcesOf = ctx => ctx.nodes.filter(n => n.kind === 'osc' || n.kind === 'buffer').length;

// ── Tests ────────────────────────────────────────────────────────────────────

test('exposes every sound name from the spec', () => {
  assert.deepEqual(
    [...SOUND_NAMES].sort(),
    ['climb', 'danger', 'deselect', 'draw', 'hop', 'invalid', 'lose', 'place', 'select', 'slide', 'throw', 'turn', 'win'].sort(),
  );
});

test('play before unlock is a no-op: no context, no nodes, no vibration', () => {
  const { made, buzz } = setup();
  for (const name of SOUND_NAMES) sfx.play(name);
  assert.equal(made.length, 0);
  assert.equal(buzz.length, 0);
});

test('unlock creates one context and resumes a suspended one', () => {
  const { made } = setup();
  sfx.unlock();
  sfx.unlock();
  assert.equal(made.length, 1);
  made[0].state = 'suspended';
  sfx.unlock();
  assert.equal(made[0].resumed, 1);
});

test('muted: play creates no nodes and does not vibrate', () => {
  const { ctx, buzz } = setup({ muted: true });
  sfx.unlock();
  const before = ctx().nodes.length;
  for (const name of SOUND_NAMES) sfx.play(name);
  assert.equal(ctx().nodes.length, before);
  assert.equal(buzz.length, 0);
  assert.equal(sfx.muted, true);
});

test('every voice builds sources and finishes in time', () => {
  for (const name of SOUND_NAMES) {
    const { ctx } = setup();
    sfx.unlock();
    const c = ctx();
    const t0 = c.currentTime;
    c.stops.length = 0;
    sfx.play(name);
    assert.ok(sourcesOf(c) > 0, `${name} built no sources`);
    const len = Math.max(...c.stops) - t0;
    const limit = ['win', 'lose', 'draw'].includes(name) ? 1.4 : 0.4;
    assert.ok(len > 0 && len <= limit, `${name} lasts ${len.toFixed(3)} s (limit ${limit})`);
  }
});

test('win is an arpeggio of about 1.2 s', () => {
  const { ctx } = setup();
  sfx.unlock();
  const c = ctx();
  sfx.play('win');
  const len = Math.max(...c.stops) - c.currentTime;
  assert.ok(len >= 1.0 && len <= 1.4, `win lasts ${len}`);
});

test('haptics: 12 ms on piece motion, patterns on danger and win, nothing on UI clicks', () => {
  const { buzz } = setup();
  sfx.unlock();
  for (const name of ['place', 'slide', 'hop', 'climb', 'throw']) {
    buzz.length = 0;
    sfx.play(name);
    assert.deepEqual(buzz, [12], name);
  }
  buzz.length = 0; sfx.play('danger'); assert.deepEqual(buzz, [[30, 40, 30]]);
  buzz.length = 0; sfx.play('win');    assert.deepEqual(buzz, [[40, 60, 80]]);
  buzz.length = 0;
  for (const name of ['select', 'deselect', 'invalid', 'turn', 'lose', 'draw']) sfx.play(name);
  assert.deepEqual(buzz, []);
});

test('play(name, { haptic: false }) sounds without vibrating', () => {
  const { ctx, buzz } = setup();
  sfx.unlock();
  sfx.play('slide', { haptic: false });
  assert.ok(sourcesOf(ctx()) > 0);
  assert.deepEqual(buzz, []);
});

test('unknown sound names are ignored', () => {
  const { ctx, buzz } = setup();
  sfx.unlock();
  const before = ctx().nodes.length;
  sfx.play('kazoo');
  assert.equal(ctx().nodes.length, before);
  assert.deepEqual(buzz, []);
});

test('the same sound retriggered within a few ms is dropped', () => {
  const { ctx } = setup();
  sfx.unlock();
  const c = ctx();
  sfx.play('select');
  const once = sourcesOf(c);
  sfx.play('select');
  assert.equal(sourcesOf(c), once);
  c.currentTime += 0.2;
  sfx.play('select');
  assert.equal(sourcesOf(c), once * 2);
});

test('setMuted persists under hiveMuted and toggle flips it', () => {
  setup();
  sfx.setMuted(true);
  assert.equal(store.get('hiveMuted'), '1');
  assert.equal(sfx.toggle(), false);
  assert.equal(sfx.muted, false);
  assert.equal(store.get('hiveMuted'), '0');
});

test('the persisted mute flag is restored on load', async () => {
  store.set('hiveMuted', '1');
  const fresh = await import('../js/audio.js?reload=1');
  assert.equal(fresh.sfx.muted, true);
  store.set('hiveMuted', '0');
});

test('softClip is transparent at normal levels and never reaches the -1 dBFS ceiling', () => {
  for (const x of [0, 0.1, -0.35, 0.7]) assert.equal(softClip(x), x);
  for (let x = 0.7; x <= 1; x += 0.01) {
    assert.ok(softClip(x) < CLIP_CEILING && softClip(x) >= 0.7, `softClip(${x})`);
    assert.equal(softClip(-x), -softClip(x));
  }
  assert.ok(softClip(0.9) > softClip(0.8), 'monotonic');
  assert.ok(20 * Math.log10(CLIP_CEILING) <= -1);
});

test('resume wakes a suspended context but never creates one', () => {
  const { made } = setup();
  sfx.resume();
  assert.equal(made.length, 0, 'no context before the first gesture');
  sfx.unlock();
  made[0].state = 'suspended';
  sfx.resume();
  assert.equal(made[0].resumed, 1);
  sfx.resume();
  assert.equal(made[0].resumed, 1, 'a running context is left alone');
});
