// audio.js — WebAudio sound effects + haptics. No asset files: every sound is synthesised.
//
//   sfx.unlock()            create/resume the AudioContext (call from a user gesture)
//   sfx.resume()            resume an existing, suspended context (e.g. tab visible again)
//   sfx.play(name, opts?)   play a voice; opts.haptic=false skips the vibration,
//                           opts.duration (ms) stretches the slide whoosh to the flight
//   sfx.setMuted(bool)      mute sound and haptics; persisted under `hiveMuted`
//   sfx.toggle() → muted    flip the mute flag
//   sfx.muted               current flag
//
// Signal chain: voices → bus ─┬─ lowpass 8 kHz ───────────────┬→ master 0.35 → soft clip → out
//                             └─ send → small plate reverb ───┘
// Palette: soft sines/triangles, detuned saws only under a lowpass, filtered-noise
// whooshes, notes from A major / A minor so overlapping sounds stay consonant.

export const MASTER_GAIN = 0.35;
const MUTE_KEY   = 'hiveMuted';
const RETRIGGER  = 0.03;   // s — the same sound again inside this window is dropped
const UNLOCK_GRACE_MS = 600; // a context still resuming after unlock may already be scheduled into

const HAPTICS = {
  place: 12, slide: 12, hop: 12, climb: 12, throw: 12,
  danger: [30, 40, 30],
  win: [40, 60, 80],
  draw: [30, 30],
};

// ── Environment hooks (overridable from tests) ─────────────────────────────

const defaultFactory = () => {
  const Ctor = globalThis.AudioContext ?? globalThis.webkitAudioContext;
  return Ctor ? new Ctor({ latencyHint: 'interactive' }) : null;
};
const defaultVibrate = pattern => {
  try { globalThis.navigator?.vibrate?.(pattern); } catch { /* unsupported */ }
};

let contextFactory = defaultFactory;
let vibrate        = defaultVibrate;
let ctx      = null;
let bus      = null;
let unlockedAt = 0;
let muted    = readMuted();
const lastPlayed = new Map();

function readMuted() {
  try { return globalThis.localStorage?.getItem(MUTE_KEY) === '1'; } catch { return false; }
}
function writeMuted(value) {
  try { globalThis.localStorage?.setItem(MUTE_KEY, value ? '1' : '0'); } catch { /* best effort */ }
}

// ── Bus ─────────────────────────────────────────────────────────────────────

function makeNoise(c, seconds = 1) {
  const buf  = c.createBuffer(1, Math.floor(c.sampleRate * seconds), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buf;
}

/** Short, dark stereo plate: decaying noise with a soft onset. */
function makeImpulse(c, seconds = 0.9) {
  const len = Math.floor(c.sampleRate * seconds);
  const buf = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      const t = i / c.sampleRate;
      const env = Math.min(1, t / 0.008) * Math.exp(-t * 6.5);
      data[i] = (Math.random() * 2 - 1) * env * 0.5;
    }
  }
  return buf;
}

export const CLIP_CEILING = 0.89; // -1 dBFS
const KNEE = 0.7;

/** Transfer curve: identity up to KNEE, then a tanh shoulder approaching CLIP_CEILING. */
export function softClip(x) {
  const a = Math.abs(x);
  if (a <= KNEE) return x;
  const room = CLIP_CEILING - KNEE;
  return Math.sign(x) * (KNEE + room * Math.tanh((a - KNEE) / room));
}

function softClipCurve(n = 2049) {
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) curve[i] = softClip((i / (n - 1)) * 2 - 1);
  return curve;
}

function buildBus(c) {
  const input = c.createGain();

  const tone = c.createBiquadFilter();
  tone.type = 'lowpass';
  tone.frequency.value = 8000;
  tone.Q.value = 0.5;

  const send = c.createGain();
  send.gain.value = 0.18;
  const verb = c.createConvolver();
  verb.buffer = makeImpulse(c);
  const verbTone = c.createBiquadFilter();
  verbTone.type = 'lowpass';
  verbTone.frequency.value = 4200;

  const master = c.createGain();
  master.gain.value = MASTER_GAIN;

  // Safety net for stacked voices: linear below 0.7, then a soft knee that never
  // reaches -1 dBFS. (A DynamicsCompressor was tried: it ducks short transients
  // from silence by ~10 dB in Chrome, so levels became unpredictable.)
  const limiter = c.createWaveShaper();
  limiter.curve = softClipCurve();
  limiter.oversample = '2x';

  input.connect(tone).connect(master);
  input.connect(send).connect(verb).connect(verbTone).connect(master);
  master.connect(limiter).connect(c.destination);

  return { input, noise: makeNoise(c) };
}

// ── Voice building blocks ───────────────────────────────────────────────────

const SILENT = 0.0001;

/** Attack/decay envelope on a fresh gain node; returns [gain, endTime]. */
function envelope(c, t, { attack = 0.004, decay = 0.15, peak = 0.3, hold = 0 }) {
  const g = c.createGain();
  g.gain.setValueAtTime(SILENT, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  if (hold) g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(SILENT, t + attack + hold + decay);
  return [g, t + attack + hold + decay];
}

/** One oscillator note with an optional pitch glide, through an optional lowpass. */
function tone(c, out, t, {
  type = 'sine', freq, to = null, glide = 0.06, detune = 0, cutoff = 0, ...env
}) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (to) o.frequency.exponentialRampToValueAtTime(to, t + glide);
  o.detune.value = detune;
  const [g, end] = envelope(c, t, env);
  let node = o;
  if (cutoff) {
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    f.Q.value = 0.4;
    node = node.connect(f);
  }
  node.connect(g).connect(out);
  o.start(t);
  o.stop(end + 0.02);
  return end;
}

/** Filtered noise with a sweeping centre frequency (whooshes, clicks). */
function noise(c, out, t, { type = 'bandpass', from, to = from, sweep, Q = 1, ...env }) {
  const src = c.createBufferSource();
  src.buffer = bus.noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = Q;
  f.frequency.setValueAtTime(from, t);
  const [g, end] = envelope(c, t, env);
  f.frequency.exponentialRampToValueAtTime(to, sweep ? t + sweep : end);
  src.connect(f).connect(g).connect(out);
  // Start at a random offset so repeated whooshes are not identical.
  src.start(t, Math.random() * 0.5);
  src.stop(end + 0.02);
  return end;
}

/** A soft analogue-style pluck: two detuned saws under a closing lowpass. */
function pluck(c, out, t, freq, { peak = 0.07, decay = 0.5, bright = 2600, dark = 700 } = {}) {
  const f = c.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = 0.7;
  f.frequency.setValueAtTime(bright, t);
  f.frequency.exponentialRampToValueAtTime(dark, t + decay * 0.8);
  const [g, end] = envelope(c, t, { attack: 0.006, decay, peak });
  f.connect(g).connect(out);
  for (const cents of [-7, 7]) {
    const o = c.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = freq;
    o.detune.value = cents;
    o.connect(f);
    o.start(t);
    o.stop(end + 0.02);
  }
  // A sine an octave down keeps the note round.
  tone(c, out, t, { freq: freq / 2, attack: 0.006, decay, peak: peak * 0.8 });
  return end;
}

// Note frequencies (Hz)
const N = {
  E3: 164.81, A3: 220, B3: 246.94, C4: 261.63, Cs4: 277.18, E4: 329.63, F4: 349.23, G4: 392,
  A4: 440, B4: 493.88, C5: 523.25, Cs5: 554.37, D5: 587.33, E5: 659.25, G5: 783.99, A5: 880,
  Cs6: 1108.73, E6: 1318.51,
};

// ── Voices ──────────────────────────────────────────────────────────────────
// Each takes (context, output, start time). Movement voices are the departure
// gesture; the landing is the `place` thump (see board.onLand in app.js).

const VOICES = {
  /** Glassy rising blip. */
  select(c, out, t) {
    tone(c, out, t, { freq: N.E5 * 0.94, to: N.E5, glide: 0.025, attack: 0.004, decay: 0.12, peak: 0.34 });
    tone(c, out, t, { type: 'triangle', freq: N.E6, attack: 0.003, decay: 0.07, peak: 0.05 });
  },

  /** The select blip falling away, a little quieter. */
  deselect(c, out, t) {
    tone(c, out, t, { freq: N.D5, to: N.A4, glide: 0.07, attack: 0.004, decay: 0.11, peak: 0.26 });
  },

  /** Muted two-step "dud": low, round, never buzzy. */
  invalid(c, out, t) {
    tone(c, out, t,        { type: 'triangle', freq: N.A3, to: N.A3 * 0.94, glide: 0.06, attack: 0.005, decay: 0.08, peak: 0.42, cutoff: 900 });
    tone(c, out, t + 0.09, { type: 'triangle', freq: N.F4 / 2, to: N.F4 / 2 * 0.94, glide: 0.06, attack: 0.005, decay: 0.12, peak: 0.42, cutoff: 900 });
  },

  /** Tile meets table: a pitched thump, a tiny wooden click and a faint neon chime. */
  place(c, out, t) {
    tone(c, out, t, { freq: 260, to: 120, glide: 0.07, attack: 0.002, decay: 0.16, peak: 0.75 });
    noise(c, out, t, { from: 1900, Q: 0.9, attack: 0.001, decay: 0.03, peak: 0.28 });
    tone(c, out, t + 0.01, { type: 'triangle', freq: N.A5, attack: 0.003, decay: 0.22, peak: 0.05 });
    tone(c, out, t + 0.01, { freq: N.E6, attack: 0.003, decay: 0.16, peak: 0.025 });
  },

  /** Airy brush: band-passed noise swelling upward with a faint tonal glide; held for a long flight (`duration`, s). */
  slide(c, out, t, { duration = 0 } = {}) {
    const hold = Math.max(0, duration - 0.27);
    noise(c, out, t, { from: 450, to: 1700, sweep: 0.26 + hold * 0.9, Q: 0.9, attack: 0.14, hold, decay: 0.13, peak: 0.42 });
    tone(c, out, t, { freq: N.A3, to: N.E4, glide: 0.22 + hold * 0.8, attack: 0.1, hold, decay: 0.16, peak: 0.06 });
  },

  /** Springy "fwip" upward plus a puff of air. */
  hop(c, out, t) {
    tone(c, out, t, { type: 'triangle', freq: N.E4, to: N.A5, glide: 0.13, attack: 0.008, decay: 0.17, peak: 0.24, cutoff: 2600 });
    noise(c, out, t, { type: 'highpass', from: 1500, to: 3000, Q: 0.5, attack: 0.02, decay: 0.09, peak: 0.12 });
  },

  /** Two quick steps up (E→A) with a light scuff each. */
  climb(c, out, t) {
    tone(c, out, t,        { freq: N.E4, attack: 0.006, decay: 0.11, peak: 0.3 });
    tone(c, out, t + 0.08, { freq: N.A4, attack: 0.006, decay: 0.18, peak: 0.3 });
    noise(c, out, t,        { from: 900, Q: 1.2, attack: 0.003, decay: 0.04, peak: 0.14 });
    noise(c, out, t + 0.08, { from: 1300, Q: 1.2, attack: 0.003, decay: 0.04, peak: 0.14 });
  },

  /** A wider arc of air: sweep up and back down, with a low sub swell. */
  throw(c, out, t) {
    const src = c.createBufferSource();
    src.buffer = bus.noise;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 1.1;
    f.frequency.setValueAtTime(350, t);
    f.frequency.exponentialRampToValueAtTime(2200, t + 0.17);
    f.frequency.exponentialRampToValueAtTime(700, t + 0.34);
    const [g, end] = envelope(c, t, { attack: 0.12, hold: 0.04, decay: 0.18, peak: 0.45 });
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random() * 0.5);
    src.stop(end + 0.02);
    tone(c, out, t, { freq: N.A3 / 2, to: N.E3, glide: 0.17, attack: 0.12, decay: 0.2, peak: 0.12 });
  },

  /** Soft two-note bell (E5 → A5). */
  turn(c, out, t) {
    for (const [dt, f] of [[0, N.E5], [0.08, N.A5]]) {
      tone(c, out, t + dt, { freq: f, attack: 0.005, decay: 0.26, peak: 0.2 });
      tone(c, out, t + dt, { freq: f * 2, attack: 0.003, decay: 0.08, peak: 0.035 });
    }
  },

  /** Two low pulses on a minor third: tense but warm. */
  danger(c, out, t) {
    for (const dt of [0, 0.16]) {
      pluck(c, out, t + dt, N.A3, { peak: 0.09, decay: 0.15, bright: 1300, dark: 400 });
      pluck(c, out, t + dt, N.C4, { peak: 0.07, decay: 0.15, bright: 1300, dark: 400 });
    }
  },

  /** Rising A-major arpeggio that blooms into a held chord (~1.2 s). */
  win(c, out, t) {
    [N.A4, N.Cs5, N.E5, N.A5].forEach((f, i) => pluck(c, out, t + i * 0.1, f, { peak: 0.08, decay: 0.32 }));
    for (const f of [N.A4, N.Cs5, N.E5, N.A5]) {
      pluck(c, out, t + 0.42, f, { peak: 0.05, decay: 0.76, bright: 3200, dark: 900 });
    }
    tone(c, out, t + 0.42, { freq: N.Cs6, attack: 0.01, decay: 0.6, peak: 0.03 });
  },

  /** Falling minor line settling on a hushed A-minor chord. */
  lose(c, out, t) {
    [N.E5, N.C5, N.A4].forEach((f, i) =>
      tone(c, out, t + i * 0.16, { type: 'triangle', freq: f, attack: 0.01, decay: 0.3, peak: 0.18, cutoff: 1800 }));
    for (const f of [N.A3, N.C4, N.E4]) {
      tone(c, out, t + 0.48, { type: 'triangle', freq: f, attack: 0.04, decay: 0.62, peak: 0.1, cutoff: 1200 });
    }
  },

  /** Neutral suspended chord (Asus2) that swells and fades. */
  draw(c, out, t) {
    for (const f of [N.A4, N.B4, N.E5]) {
      tone(c, out, t, { type: 'triangle', freq: f, attack: 0.08, hold: 0.2, decay: 0.7, peak: 0.1, cutoff: 1800 });
    }
    tone(c, out, t, { freq: N.A3, attack: 0.08, hold: 0.2, decay: 0.7, peak: 0.12 });
  },
};

export const SOUND_NAMES = Object.freeze(Object.keys(VOICES));

// Per-voice trim (dB), balanced from offline renders so UI ticks sit around
// -14…-16 dBFS, piece sounds -9…-15 and the end-of-game stings -9…-11 (peaks,
// after the master gain). Broadband whooshes sit lower than tones of equal peak.
const TRIM_DB = {
  select: 4, deselect: 5, invalid: 3.3, place: 2.4, slide: 10, hop: 5.3, climb: 7,
  throw: 7, turn: 9, danger: 10.8, win: 9.7, lose: 10.5, draw: 6.4,
};

// ── Public API ──────────────────────────────────────────────────────────────

export const sfx = {
  /** Create (first call) or resume the AudioContext. Call from a user gesture. */
  unlock() {
    if (!ctx) {
      try { ctx = contextFactory(); } catch { ctx = null; }
      if (!ctx) return;
      bus = buildBus(ctx);
    }
    unlockedAt = Date.now();
    if (ctx.state !== 'running' && ctx.resume) {
      try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* offline/closed */ }
    }
  },

  /**
   * Wake a context the browser suspended (tab hidden, iOS interruption). Never
   * creates one: that still needs a user gesture (unlock).
   */
  resume() {
    if (!ctx || ctx.state === 'running' || !ctx.resume) return;
    try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* closed */ }
  },

  /**
   * Play `name` (see SOUND_NAMES). No-op before unlock, while muted, or for unknown names.
   * `duration` (ms) stretches a voice that follows a movement (the slide whoosh) to its length.
   */
  play(name, { haptic = true, duration = 0 } = {}) {
    const voice = VOICES[name];
    if (!voice || muted || !ctx || !bus) return;
    // A context the browser suspended (background tab) would replay a backlog on resume.
    if (ctx.state !== 'running' && Date.now() - unlockedAt > UNLOCK_GRACE_MS) return;
    const t = ctx.currentTime;
    if (t - (lastPlayed.get(name) ?? -Infinity) < RETRIGGER) return;
    lastPlayed.set(name, t);
    try {
      const out = ctx.createGain();
      out.gain.value = 10 ** ((TRIM_DB[name] ?? 0) / 20);
      out.connect(bus.input);
      voice(ctx, out, t + 0.005, { duration: duration / 1000 });
    } catch { /* never let audio break the game */ }
    if (haptic && HAPTICS[name]) vibrate(HAPTICS[name]);
  },

  setMuted(value) {
    muted = !!value;
    writeMuted(muted);
  },

  toggle() {
    this.setMuted(!muted);
    return muted;
  },

  get muted() { return muted; },

  // ── Test hooks ──
  _setContextFactory(fn) { contextFactory = fn ?? defaultFactory; },
  _setVibrate(fn) { vibrate = fn ?? defaultVibrate; },
  _reset() {
    ctx = null;
    bus = null;
    unlockedAt = 0;
    lastPlayed.clear();
    contextFactory = defaultFactory;
    vibrate = defaultVibrate;
  },
};
