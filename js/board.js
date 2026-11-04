// board.js — Canvas renderer + pointer input
// Depends on: hex.js (must load first)

import { hexToPixel, pixelToHex, hexNeighbors, hexKey, parseKey } from './hex.js';
import { drawSprite, bodyFill, SPECIES_COLOR } from './sprites.js';

const BG         = '#05050f';
const P1         = '#ff2d78';
const P2         = '#00f5ff';
const GHOST      = '#39ff14';
const AMBER      = '#ffb300';
const GOLD       = '#ffd700';
const MIN_SCALE  = 0.2;
const MAX_SCALE  = 3.5;
const FIT_SCALE  = 1.25; // recenter never zooms in further than this
const FIT_PAD    = 16;   // px of breathing room around the hive when fitting
const CAMERA_MS  = 380;
const ARRIVAL_MS = 320;

// ── Tile look ──
const RIM       = 0.09;  // rim width as a fraction of the tile radius
const LIP       = 0.10;  // how far the tile's side (thickness) shows below its face
const GLYPH_BOX = 1.34;  // sprite box per tile radius (the art fills ~78% of its box)
const FACE_HI   = '#141428';
const FACE_LO   = '#07070f';
const TILE = {
  1: { rim: P1, rimHi: 'rgba(255,214,230,.75)', lip: '#3b0a20', lipEdge: 'rgba(255,45,120,.45)' },
  2: { rim: P2, rimHi: 'rgba(214,253,255,.75)', lip: '#043239', lipEdge: 'rgba(0,245,255,.40)' },
};

/**
 * Layout of a stack's tiles, bottom first, for a tile of radius `size`. Each
 * layer up rises and shrinks a step; deeper layers are shaded darker. The rise
 * and shrink are spread so even a 7-high stack stays within its cell.
 * @returns {{dx:number, dy:number, scale:number, shade:number}[]}
 */
export function stackLayers(height, size) {
  const steps = Math.max(1, height - 1);
  const rise   = Math.min(0.13, 0.3 / steps);
  const shrink = Math.min(0.035, 0.18 / steps);
  return Array.from({ length: height }, (_, i) => ({
    dx:    0,
    dy:    i === 0 ? 0 : -(size * rise * i),
    scale: 1 - shrink * i,
    shade: 1 - Math.pow(0.6, height - 1 - i),
  }));
}

// ── Hive layer cache ──
// The hive (grid hints, tiles, stacks, glyphs, badges, static marks) is drawn
// into offscreen layers and only re-rendered when its inputs change; each frame
// blits the layers and draws the animated overlays on top.
const LAYER_PAD      = 3;    // hexes of padding around the hive (grid hints, glows)
const LAYER_MARGIN   = 0.25; // a viewport-clipped layer reaches this far past each edge
const ZOOM_SETTLE_MS = 140;  // while zooming, blit the stale layer scaled; re-render once settled
const MIN_LINE_PX    = 1.5;  // thinnest screen-px line for the selection ring and last-move ticks
const BADGE_FULL_R   = 22;   // top-face radius (screen px) from which full stack badges show
const BADGE_MIN_R    = 9;    // below this the stepped slabs alone show the height

/**
 * Content signature of the cached hive layer: everything the layer draws
 * except the camera (scale/dpr/coverage are checked separately). Equal keys
 * mean the cached pixels are still right. Cheap enough to build every frame,
 * and it sees in-place mutation of `pieces`.
 */
export function hiveLayerKey({ pieces, ghosts, selectedHex, throwPick, lastMove, hiddenTop, hiddenStacks }) {
  let s = '';
  for (const [key, stack] of pieces) {
    s += key + ':';
    for (const p of stack) s += p.player + p.type + (p.image ? '*' : '') + '/';
    s += ';';
  }
  const list = set => (set ? [...set].join(',') : '');
  const lm = lastMove ? `${lastMove.from ?? ''}>${lastMove.to}@${lastMove.player}` : '';
  return [s, list(ghosts), selectedHex ?? '', throwPick ?? '', lm, list(hiddenTop), list(hiddenStacks)].join('|');
}

/** Board-space box around the centres of `keys`, padded by `pad`; null if empty. */
export function hiveBounds(keys, size, pad) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const key of keys) {
    const { q, r } = parseKey(key);
    const p = hexToPixel(q, r, size);
    x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
    y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
  }
  if (x0 === Infinity) return null;
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}

/** True when the part of `content` inside `view` lies within `layer` (all rects in board space). */
export function layerCovers(layer, view, content) {
  if (!content) return true;
  const x0 = Math.max(view.x0, content.x0), x1 = Math.min(view.x1, content.x1);
  const y0 = Math.max(view.y0, content.y0), y1 = Math.min(view.y1, content.y1);
  if (x0 >= x1 || y0 >= y1) return true;
  return x0 >= layer.x0 && x1 <= layer.x1 && y0 >= layer.y0 && y1 <= layer.y1;
}

/**
 * Stack badge geometry for a top face of radius `r` screen px. Everything
 * scales with the tile and stays inside it:
 *  - 'full'    — a ×N pill (upper right) plus a hex chip per buried piece along the lower rim
 *  - 'compact' — one small numeral disc tucked into the upper-right corner
 *  - 'none'    — too small for text; the stepped slabs show the height
 * `chipDist`/`angle` place the (first) chip relative to the face centre.
 */
export function badgeLayout(r) {
  if (r < BADGE_MIN_R) return { mode: 'none', chipR: 0, chipDist: 0, angle: 0, font: 0 };
  if (r < BADGE_FULL_R) {
    return { mode: 'compact', chipR: r * 0.27, chipDist: r * 0.62, angle: -Math.PI * 0.31, font: r * 0.34 };
  }
  return {
    mode: 'full', chipR: r * 0.17, chipDist: r * 0.74, angle: Math.PI * 0.1, step: Math.PI * 0.13,
    font: Math.max(6, Math.round(r * 0.2)), pillX: r * 0.45, pillY: -r * 0.62,
  };
}

/** Glow rings blitted every frame from pre-rendered sprites (no per-frame shadowBlur). R in board units. */
const RINGS = {
  ghost:    { R: 48, lw: 1.5, color: GHOST, blur: 16 },
  ghostOcc: { R: 53, lw: 2.5, color: GHOST, blur: 22 },
  amber:    { R: 53, lw: 3.5, color: AMBER, blur: 20 },
  pick:     { R: 54, lw: 4,   color: '#fff4d1', glow: AMBER, blur: 24, minPx: MIN_LINE_PX * 1.4 },
  sel:      { R: 55, lw: 2.5, color: '#ffffff', blur: 8,  minPx: MIN_LINE_PX },
  selGlow:  { R: 55, lw: 2.5, color: '#ffffff', blur: 22, minPx: MIN_LINE_PX },
};

const easeOutCubic = p => 1 - Math.pow(1 - p, 3);
const easeOutBack  = p => 1 + 2.2 * Math.pow(p - 1, 3) + 1.2 * Math.pow(p - 1, 2);

export class Board {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {HTMLCanvasElement} emojiCanvas
   */
  constructor(canvas, emojiCanvas) {
    this.canvas      = canvas;
    this.ctx         = canvas.getContext('2d');
    this.emojiCanvas = emojiCanvas;
    this.emojiCtx    = emojiCanvas.getContext('2d');
    this.SIZE   = 50; // hex circumradius in board-space units

    // Viewport, in CSS pixels. The backing stores are scaled by dpr.
    this.W   = 0;
    this.H   = 0;
    this.dpr = 1;
    /** Screen space covered by the HUD (top) and tray (bottom); recenter avoids it. */
    this.insets = { top: 0, bottom: 0 };

    // Viewport transform: board-space → screen-space (CSS px)
    this.tx    = 0;
    this.ty    = 0;
    this.scale = 1;

    // ── Game data (written by app.js) ──
    /** @type {Map<string, Array<{player:1|2, type:string, emoji:string, text?:string, kind?:string, image?:HTMLImageElement}>>} */
    this.pieces      = new Map();
    /** @type {Set<string>} hex keys to draw as placement/move targets */
    this.ghosts       = new Set();
    /** @type {Set<string>} hex keys of pieces the pillbug can throw (amber) */
    this.throwTargets = new Set();
    /** @type {string|null} hex key of the currently selected on-board piece */
    this.selectedHex = null;
    /** @type {{from:string|null, to:string, player:1|2}|null} most recent action */
    this.lastMove    = null;

    /** @type {string|null} piece picked for a pillbug throw (lifted, bright ring) */
    this.throwPick   = null;
    /** @type {Set<string>} hexes whose top piece is left out of the hive layer (drawn in flight) */
    this.hiddenTop   = new Set();
    /** @type {{piece:{player:1|2,type:string}, x:number, y:number, lift?:number, scale?:number}[]}
     *  pieces drawn live each frame at board-space (x, y), e.g. while moving */
    this.floating    = [];

    this.reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this._camera  = null; // { from, to, start } while animating a recenter
    this._arrival = null; // { key, start } while a newly arrived piece pops in

    // ── Hive layer cache (see draw) ──
    this._layer      = null;      // { board, glyphs, key, rect, scale, dpr, faces, bx0, by0, id }
    this._dirty      = true;
    this._rings      = new Map(); // kind → { S, canvas } glow-ring sprites
    this._prevScale  = this.scale;
    this._zoomedAt   = -Infinity;
    this._glyphStamp = null;      // what #emoji-layer currently shows
    this._glyphsLive = false;

    // ── Starfield ──
    this._stars = Array.from({ length: 220 }, () => ({
      x:     Math.random(),
      y:     Math.random(),
      r:     Math.random() * 1.5 + 0.25,
      base:  Math.random() * 0.55 + 0.15,
      speed: Math.random() * 1.8 + 0.4,
      phase: Math.random() * Math.PI * 2,
    }));

    // ── Pointer tracking ──
    /** @type {Map<number, {x:number,y:number}>} active pointers */
    this._pts        = new Map();
    this._dragOrigin = null; // {x, y, tx, ty} — pan reference
    this._hasMoved   = false;
    this._multi      = false; // true once a second pointer joins the gesture
    this._pinchLast  = 0;

    /** Callback fired on a clean tap: (q, r, clientX, clientY) => void */
    this.onTap = null;
    /** Desktop hover callback: (q, r, clientX, clientY) or (null) when leaving. */
    this.onHover = null;
    /** Fired once when the user first pans or zooms. */
    this.onViewChange = null;

    this._bindEvents();
  }

  // ── Setup ──────────────────────────────────────────────

  /** Center the viewport on the hive (or origin). Kept for older callers. */
  init() {
    this.recenter(false);
  }

  /**
   * Resize both canvases to w×h CSS pixels, keeping the same board point
   * under the viewport center. Backing stores are scaled for crisp rendering.
   */
  resize(w, h, dpr = globalThis.devicePixelRatio || 1) {
    const prevW = this.W, prevH = this.H;
    this.dpr = Math.min(2, Math.max(1, dpr));
    this.W = w;
    this.H = h;
    for (const c of [this.canvas, this.emojiCanvas]) {
      c.width  = Math.round(w * this.dpr);
      c.height = Math.round(h * this.dpr);
      c.style.width  = `${w}px`;
      c.style.height = `${h}px`;
    }
    this._dirty = true;
    this._glyphStamp = null; // resizing cleared #emoji-layer
    if (prevW) {
      this.tx += (w - prevW) / 2;
      this.ty += (h - prevH) / 2;
    } else {
      this.tx = w / 2;
      this.ty = h / 2;
    }
  }

  // ── Camera ─────────────────────────────────────────────

  /** Fit the whole hive into the area between the HUD and tray. */
  recenter(animate = true) {
    const target = this._fitTarget();
    if (!animate || this.reducedMotion) {
      this._camera = null;
      Object.assign(this, target);
      return;
    }
    this._camera = { from: { tx: this.tx, ty: this.ty, scale: this.scale }, to: target, start: null };
  }

  /** Recenter only if some piece has drifted outside the visible area. */
  ensureHiveVisible() {
    const { top, bottom } = this.insets;
    const pad = this.SIZE * this.scale * 0.6;
    for (const key of this.pieces.keys()) {
      const { x, y } = this.hexToScreen(key);
      if (x < pad || x > this.W - pad || y < top + pad || y > this.H - bottom - pad) {
        this.recenter(true);
        return;
      }
    }
  }

  /** Zoom around the center of the playable area (keyboard / buttons). */
  zoomBy(ratio) {
    this._camera = null;
    const cy = this.insets.top + (this.H - this.insets.top - this.insets.bottom) / 2;
    this._applyZoom(ratio, this.W / 2, cy);
  }

  /** Screen position (CSS px) of a hex center. */
  hexToScreen(key) {
    const { q, r } = parseKey(key);
    const p = hexToPixel(q, r, this.SIZE);
    return { x: this.tx + p.x * this.scale, y: this.ty + p.y * this.scale };
  }

  /** Pop-in animation for a piece that just arrived at `key`. */
  markArrival(key) {
    this._arrival = this.reducedMotion ? null : { key, start: null };
  }

  _fitTarget() {
    const { top, bottom } = this.insets;
    const availH = Math.max(1, this.H - top - bottom);
    const cx = this.W / 2;
    const cy = top + availH / 2;
    if (this.pieces.size === 0) return { tx: cx, ty: cy, scale: 1 };

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const key of this.pieces.keys()) {
      const { q, r } = parseKey(key);
      const p = hexToPixel(q, r, this.SIZE);
      minX = Math.min(minX, p.x - this.SIZE); maxX = Math.max(maxX, p.x + this.SIZE);
      minY = Math.min(minY, p.y - this.SIZE); maxY = Math.max(maxY, p.y + this.SIZE);
    }
    const scale = Math.max(MIN_SCALE, Math.min(
      FIT_SCALE,
      (this.W - FIT_PAD * 2) / (maxX - minX),
      (availH - FIT_PAD * 2) / (maxY - minY),
    ));
    return {
      tx: cx - ((minX + maxX) / 2) * scale,
      ty: cy - ((minY + maxY) / 2) * scale,
      scale,
    };
  }

  _stepCamera(t) {
    const cam = this._camera;
    if (!cam) return;
    if (cam.start === null) cam.start = t;
    const p = Math.min(1, (t - cam.start) / CAMERA_MS);
    const e = easeOutCubic(p);
    this.tx    = cam.from.tx    + (cam.to.tx    - cam.from.tx)    * e;
    this.ty    = cam.from.ty    + (cam.to.ty    - cam.from.ty)    * e;
    this.scale = cam.from.scale + (cam.to.scale - cam.from.scale) * e;
    if (p === 1) this._camera = null;
  }

  _arrivalScale(key, t) {
    const a = this._arrival;
    if (!a || a.key !== key) return 1;
    if (a.start === null) a.start = t;
    const p = Math.min(1, (t - a.start) / ARRIVAL_MS);
    if (p === 1) { this._arrival = null; return 1; }
    return Math.max(0.2, easeOutBack(p));
  }

  // ── Render loop ────────────────────────────────────────

  /** Mark the cached hive layer stale; the next frame re-renders it. */
  invalidate() {
    this._dirty = true;
  }

  /**
   * Each frame: background + stars, then the cached hive layer (re-rendered only
   * when its inputs changed), then the animated overlays — loose pieces (arrival
   * pop, `floating`), selection / throw-pick rings, ghost and throw pulses. The
   * glyph canvas is only touched when its layer moved or a loose piece is live.
   */
  draw(t) {
    const ctx = this.ctx;
    const W = this.W, H = this.H, dpr = this.dpr;
    this._stepCamera(t);
    if (this.scale !== this._prevScale) { this._prevScale = this.scale; this._zoomedAt = t; }

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalAlpha = 1;
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);
    this._drawStars(ctx, W, H, t);

    const loose = this._loosePieces(t);
    const layer = this._currentLayer(t, loose);

    // Blit the layer, pixel-aligned (scaled only while a zoom settles).
    const k  = this.scale / layer.scale;
    const gx = Math.round((this.tx + layer.bx0 * this.scale) * dpr);
    const gy = Math.round((this.ty + layer.by0 * this.scale) * dpr);
    const gw = k === 1 ? layer.board.width  : layer.board.width  * k;
    const gh = k === 1 ? layer.board.height : layer.board.height * k;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(layer.board, gx, gy, gw, gh);

    // Animated overlays, in board space.
    const S = dpr * this.scale;
    ctx.setTransform(S, 0, 0, S, this.tx * dpr, this.ty * dpr);
    const faces = new Map(layer.faces);
    for (const lp of loose) {
      if (lp.stack) this._drawStack(ctx, lp.key, lp.stack, lp.x, lp.y, lp.pop, faces);
      else          this._drawFloating(ctx, lp, faces);
    }
    this._drawSelectionRing(ctx, t);
    this._drawThrowPick(ctx, t, faces);
    this._drawGhostPulses(ctx, t, faces);

    this._compositeGlyphs(layer, gx, gy, gw, gh, loose, faces);
  }

  /**
   * Pieces drawn live this frame instead of from the layer: the stack popping
   * in at `_arrival`, plus every `floating` piece (in flight, board space).
   */
  _loosePieces(t) {
    const loose = [];
    const a = this._arrival;
    if (a && this.pieces.has(a.key)) {
      const pop = this._arrivalScale(a.key, t);
      if (this._arrival) {
        const { q, r } = parseKey(a.key);
        const p = hexToPixel(q, r, this.SIZE);
        loose.push({ key: a.key, stack: this.pieces.get(a.key), x: p.x, y: p.y, pop });
      }
    }
    for (const f of this.floating) loose.push({ key: null, ...f });
    return loose;
  }

  /** The hive layer for this frame: the cached one if still valid, else a fresh render. */
  _currentLayer(t, loose) {
    const hiddenStacks = new Set(loose.filter(lp => lp.stack).map(lp => lp.key));
    const key = hiveLayerKey({
      pieces: this.pieces, ghosts: this.ghosts, selectedHex: this.selectedHex, throwPick: this.throwPick,
      lastMove: this.lastMove, hiddenTop: this.hiddenTop, hiddenStacks,
    });
    const content = this._contentBounds();
    const L = this._layer;
    if (L && !this._dirty && L.key === key && L.dpr === this.dpr && layerCovers(L.rect, this._viewRect(0), content)) {
      if (L.scale === this.scale) return L;
      const ratio    = this.scale / L.scale;
      const zooming  = this._camera || t - this._zoomedAt < ZOOM_SETTLE_MS;
      if (zooming && ratio > 0.67 && ratio < 1.5) return L;
    }
    return this._renderLayer(key, content, hiddenStacks);
  }

  /** Board-space box of everything the layer can draw. */
  _contentBounds() {
    const keys = [...this.pieces.keys(), ...this.ghosts];
    if (this.lastMove?.from) keys.push(this.lastMove.from);
    if (!this.pieces.size) keys.push('0,0'); // the dashed first-placement hint
    return hiveBounds(keys, this.SIZE, this.SIZE * LAYER_PAD);
  }

  /** Visible board-space rect, grown by `margin` × the viewport on every side. */
  _viewRect(margin) {
    const mx = this.W * margin, my = this.H * margin, s = this.scale;
    return {
      x0: (-mx - this.tx) / s,          y0: (-my - this.ty) / s,
      x1: (this.W + mx - this.tx) / s,  y1: (this.H + my - this.ty) / s,
    };
  }

  _makeCanvas() {
    return globalThis.document.createElement('canvas');
  }

  /**
   * Render the hive into the two layer canvases: tiles and marks for #board,
   * glyphs and badges for #emoji-layer (separate contexts — the glyph content
   * never shares state with the animated board canvas). The layer covers the
   * hive, clipped to the viewport plus LAYER_MARGIN, at the current scale/dpr.
   */
  _renderLayer(key, content, hiddenStacks) {
    const dpr = this.dpr, s = this.scale;
    const L = this._layer ??= { board: this._makeCanvas(), glyphs: this._makeCanvas(), id: 0 };

    const view = this._viewRect(LAYER_MARGIN);
    const rect = content && {
      x0: Math.max(content.x0, view.x0), y0: Math.max(content.y0, view.y0),
      x1: Math.min(content.x1, view.x1), y1: Math.min(content.y1, view.y1),
    };
    const visible = rect && rect.x0 < rect.x1 && rect.y0 < rect.y1;
    let devX0 = 0, devY0 = 0, w = 1, h = 1;
    if (visible) {
      devX0 = Math.floor((this.tx + rect.x0 * s) * dpr);
      devY0 = Math.floor((this.ty + rect.y0 * s) * dpr);
      w = Math.max(1, Math.ceil((this.tx + rect.x1 * s) * dpr) - devX0);
      h = Math.max(1, Math.ceil((this.ty + rect.y1 * s) * dpr) - devY0);
    }
    for (const c of [L.board, L.glyphs]) {
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
      else c.getContext('2d').clearRect(0, 0, w, h);
    }

    let faces = new Map();
    if (visible) {
      const bctx = L.board.getContext('2d');
      bctx.setTransform(dpr * s, 0, 0, dpr * s, this.tx * dpr - devX0, this.ty * dpr - devY0);
      this._drawGridHints(bctx);
      this._drawLastMoveSource(bctx);
      faces = this._drawPieces(bctx, hiddenStacks);
      this._drawLastMoveRing(bctx);
      this._drawGhostBases(bctx);

      const gctx = L.glyphs.getContext('2d');
      gctx.setTransform(dpr, 0, 0, dpr, -devX0, -devY0);
      this._drawGlyphs(gctx, faces);
    }

    Object.assign(L, {
      key, dpr, scale: s, faces, id: L.id + 1,
      rect: visible ? rect : { x0: 0, y0: 0, x1: 0, y1: 0 },
      bx0: (devX0 / dpr - this.tx) / s,
      by0: (devY0 / dpr - this.ty) / s,
    });
    this._dirty = false;
    return L;
  }

  /**
   * Update #emoji-layer: blit the glyph layer where the board layer went, then
   * draw live glyphs for loose pieces. Skipped entirely while nothing changed.
   */
  _compositeGlyphs(layer, gx, gy, gw, gh, loose, faces) {
    const stamp = `${layer.id}|${gx}|${gy}|${gw}|${gh}`;
    const live  = loose.length > 0;
    if (!live && !this._glyphsLive && stamp === this._glyphStamp) return;
    this._glyphStamp = stamp;
    this._glyphsLive = live;

    const ec = this.emojiCtx;
    ec.setTransform(1, 0, 0, 1, 0, 0);
    ec.globalAlpha = 1;
    ec.globalCompositeOperation = 'source-over';
    ec.clearRect(0, 0, this.emojiCanvas.width, this.emojiCanvas.height);
    ec.drawImage(layer.glyphs, gx, gy, gw, gh);
    if (!live) return;

    ec.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const liveFaces = new Map();
    for (const lp of loose) {
      const id = lp.key ?? lp;
      if (faces.has(id)) liveFaces.set(id, faces.get(id));
    }
    this._drawGlyphs(ec, liveFaces);
  }

  // ── Private render helpers ─────────────────────────────

  _drawStars(ctx, W, H, t) {
    for (const s of this._stars) {
      const a = s.base * (0.45 + 0.55 * Math.sin(t * 0.001 * s.speed + s.phase));
      ctx.beginPath();
      ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${a.toFixed(3)})`;
      ctx.fill();
    }
  }

  _drawGridHints(ctx) {
    // If board is empty, show a single dashed hint at origin
    if (this.pieces.size === 0) {
      ctx.save();
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = 'rgba(255,255,255,0.16)';
      ctx.lineWidth = 1;
      this._hexPath(ctx, 0, 0, this.SIZE - 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Faint outlines around every occupied hex's empty neighbors
    const shown = new Set();
    ctx.strokeStyle = 'rgba(255,255,255,0.055)';
    ctx.lineWidth = 1;
    for (const key of this.pieces.keys()) {
      const { q, r } = parseKey(key);
      for (const n of hexNeighbors(q, r)) {
        const nk = hexKey(n.q, n.r);
        if (!this.pieces.has(nk) && !shown.has(nk)) {
          shown.add(nk);
          const p = hexToPixel(n.q, n.r, this.SIZE);
          this._hexPath(ctx, p.x, p.y, this.SIZE - 2);
          ctx.stroke();
        }
      }
    }
  }

  /** Dashed outline where the last-moved piece came from (if now empty). */
  _drawLastMoveSource(ctx) {
    const lm = this.lastMove;
    if (!lm?.from || this.pieces.has(lm.from)) return;
    const { q, r } = parseKey(lm.from);
    const p = hexToPixel(q, r, this.SIZE);
    ctx.save();
    ctx.setLineDash([4, 6]);
    ctx.strokeStyle = lm.player === 1 ? 'rgba(255,45,120,.45)' : 'rgba(0,245,255,.45)';
    ctx.lineWidth = Math.max(1.5, MIN_LINE_PX / this.scale);
    this._hexPath(ctx, p.x, p.y, this.SIZE - 6);
    ctx.stroke();
    ctx.restore();
  }

  /** Gold corner ticks around the piece that moved last (never thinner than MIN_LINE_PX). */
  _drawLastMoveRing(ctx) {
    const lm = this.lastMove;
    if (!lm?.to || !this.pieces.has(lm.to)) return;
    const { q, r } = parseKey(lm.to);
    const p = hexToPixel(q, r, this.SIZE);
    const R   = this.SIZE + 4;
    const len = Math.max(11, 4 / this.scale);
    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.globalAlpha = 0.9;
    ctx.lineWidth   = Math.max(2.75, MIN_LINE_PX / this.scale);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const cx = p.x + R * Math.cos(a), cy = p.y + R * Math.sin(a);
      const a1 = a + (2 * Math.PI) / 3, a2 = a - (2 * Math.PI) / 3; // along the two edges
      ctx.beginPath();
      ctx.moveTo(cx + len * Math.cos(a1), cy + len * Math.sin(a1));
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + len * Math.cos(a2), cy + len * Math.sin(a2));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** The static part of empty move/placement targets: faint fill and centre dot. */
  _drawGhostBases(ctx) {
    ctx.save();
    ctx.shadowBlur  = 16;
    ctx.shadowColor = GHOST;
    for (const key of this.ghosts) {
      if (this.pieces.has(key)) continue;
      const { q, r } = parseKey(key);
      const p = hexToPixel(q, r, this.SIZE);
      this._hexPath(ctx, p.x, p.y, this.SIZE - 2);
      ctx.fillStyle = 'rgba(57,255,20,0.09)';
      ctx.fill();
      ctx.beginPath();
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(57,255,20,0.55)';
      ctx.fill();
    }
    ctx.restore();
  }

  /** Pulsing rings on move targets, beetle-climb tints, and amber throwable rings. */
  _drawGhostPulses(ctx, t, faces) {
    const pulse = 0.38 + 0.30 * Math.sin(t / 360);
    for (const key of this.ghosts) {
      const occupied = this.pieces.has(key); // beetle can climb onto occupied hexes
      if (occupied) this._tintFace(ctx, faces.get(key), '57,255,20', pulse);
      this._blitRing(ctx, occupied ? 'ghostOcc' : 'ghost', key, pulse);
    }

    if (this.throwTargets.size === 0) return;
    const amberPulse = 0.50 + 0.38 * Math.sin(t / 310);
    for (const key of this.throwTargets) {
      if (key === this.throwPick) continue;
      this._tintFace(ctx, faces.get(key), '255,179,0', amberPulse);
      this._blitRing(ctx, 'amber', key, amberPulse);
    }
  }

  /** The piece picked for a pillbug throw: lifted (in the layer), bright ring, warm face. */
  _drawThrowPick(ctx, t, faces) {
    if (!this.throwPick || !this.pieces.has(this.throwPick)) return;
    const pulse = 0.5 + 0.5 * Math.sin(t / 240);
    this._tintFace(ctx, faces.get(this.throwPick), '255,236,170', 0.35 + 0.25 * pulse);
    this._blitRing(ctx, 'pick', this.throwPick, 0.85 + 0.15 * pulse);
  }

  /** White pulsing ring outside the selected cell, drawn over every tile. */
  _drawSelectionRing(ctx, t) {
    if (!this.selectedHex || !this.pieces.has(this.selectedHex)) return;
    const p = 0.5 + 0.5 * Math.sin(t / 240);
    const grow = (RINGS.sel.R + 3 * p) / RINGS.sel.R;
    this._blitRing(ctx, 'selGlow', this.selectedHex, 0.25 + 0.6 * p, grow);
    this._blitRing(ctx, 'sel', this.selectedHex, 0.6 + 0.4 * p, grow);
  }

  /**
   * Blit a pre-rendered glow ring centred on hex `key` at `alpha`, grown by
   * `grow`. Restores the board-space transform afterwards.
   */
  _blitRing(ctx, kind, key, alpha, grow = 1) {
    const spr = this._ringSprite(kind);
    const { q, r } = parseKey(key);
    const p = hexToPixel(q, r, this.SIZE);
    const dpr = this.dpr;
    const w = spr.width * grow, h = spr.height * grow;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = Math.max(0, Math.min(1, alpha));
    ctx.drawImage(spr,
      Math.round((this.tx + p.x * this.scale) * dpr - w / 2),
      Math.round((this.ty + p.y * this.scale) * dpr - h / 2), w, h);
    ctx.restore();
  }

  /** A RINGS sprite rendered at the current scale × dpr (cached until that changes). */
  _ringSprite(kind) {
    const S = this.scale * this.dpr;
    const cached = this._rings.get(kind);
    if (cached?.S === S) return cached.canvas;

    const spec = RINGS[kind];
    const lw   = Math.max(spec.lw, (spec.minPx ?? 0) / this.scale);
    const half = Math.ceil((spec.R + lw) * S + spec.blur * 1.6 + 2);
    const canvas = cached?.canvas ?? this._makeCanvas();
    canvas.width = canvas.height = half * 2;
    const g = canvas.getContext('2d');
    g.setTransform(S, 0, 0, S, half, half);
    g.shadowBlur  = spec.blur;
    g.shadowColor = spec.glow ?? spec.color;
    g.strokeStyle = spec.color;
    g.lineWidth   = lw;
    g.lineJoin    = 'round';
    this._hexPath(g, 0, 0, spec.R);
    g.stroke();
    this._rings.set(kind, { S, canvas });
    return canvas;
  }

  /**
   * Draw every stack as stepped 3D tiles. Stacks are painted back-to-front
   * (top row first) so a tile's lip and a raised stack overlap the row behind.
   * Stacks in `hiddenStacks` are skipped and `hiddenTop` hexes lose their top
   * piece (both are drawn live as overlays instead).
   * @returns {Map<string, {x:number, y:number, r:number, stack:Array}>} top-face
   *          geometry in board space, so the glyph layer lines up with lifts.
   */
  _drawPieces(ctx, hiddenStacks = new Set()) {
    const faces = new Map();
    const order = [...this.pieces.keys()].map(key => {
      const { q, r } = parseKey(key);
      return { key, p: hexToPixel(q, r, this.SIZE) };
    }).sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x);

    for (const { key, p } of order) {
      if (hiddenStacks.has(key)) continue;
      let stack = this.pieces.get(key);
      if (this.hiddenTop.has(key)) stack = stack.slice(0, -1);
      if (stack.length) this._drawStack(ctx, key, stack, p.x, p.y, 1, faces);
    }
    return faces;
  }

  /** One stack at (x0, y0); `pop` scales the top tile (arrival). Records its top face. */
  _drawStack(ctx, key, stack, x0, y0, pop, faces) {
    const tileR    = this.SIZE - 2;
    const selected = key === this.selectedHex;
    const picked   = key === this.throwPick;
    const layers   = stackLayers(stack.length, tileR);
    const topIdx   = stack.length - 1;
    for (let i = 0; i <= topIdx; i++) {
      const L     = layers[i];
      const isTop = i === topIdx;
      const lift  = isTop && (selected || picked) ? tileR * (picked ? 0.12 : 0.06) : 0;
      const x = x0 + L.dx, y = y0 + L.dy - lift;
      const r = tileR * L.scale * (isTop ? pop : 1);
      this._drawTile(ctx, x, y, r, stack[i].player, {
        shade: L.shade, selected: isTop && selected, picked: isTop && picked, lift,
      });
      if (isTop) faces.set(key, { x, y, r, stack });
    }
  }

  /** A single in-flight piece from `floating` (board space), keyed by its entry. */
  _drawFloating(ctx, f, faces) {
    const r = (this.SIZE - 2) * (f.scale ?? 1);
    const lift = f.lift ?? 0;
    this._drawTile(ctx, f.x, f.y - lift, r, f.piece.player, { lift });
    faces.set(f, { x: f.x, y: f.y - lift, r, stack: [f.piece] });
  }

  /** Pulsing colour wash + inner ring on a tile's face (glyph stays on top). */
  _tintFace(ctx, face, rgb, pulse) {
    if (!face) return;
    const inner = face.r * (1 - RIM * 1.6);
    ctx.save();
    ctx.shadowBlur = 0;
    this._hexPath(ctx, face.x, face.y, inner);
    ctx.fillStyle = `rgba(${rgb},${(0.10 + 0.14 * pulse).toFixed(3)})`;
    ctx.fill();
    ctx.strokeStyle = `rgba(${rgb},${(0.45 + 0.4 * pulse).toFixed(3)})`;
    ctx.lineWidth   = Math.max(1.5, face.r * 0.05);
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * One tile: soft drop shadow, a player-tinted lip for thickness, a dark
   * bevelled face, a thick glowing rim in the owner's colour and a top-edge
   * highlight. `shade` (0..1) darkens buried slabs; `selected` gives the rim a
   * white glow, `picked` (pillbug throw) a hot amber one.
   */
  _drawTile(ctx, x, y, r, player, { shade = 0, selected = false, picked = false, lift = 0 }) {
    const pal   = TILE[player] ?? TILE[1];
    const rimW  = r * RIM;
    const lipDy = r * LIP;

    ctx.save();

    // Contact shadow: grounds the tile; grows when the tile is lifted.
    ctx.shadowColor   = 'rgba(0,0,0,.75)';
    ctx.shadowBlur    = r * 0.22 + lift * 2;
    ctx.shadowOffsetY = r * 0.06 + lift;
    this._hexPath(ctx, x, y + lipDy, r);
    ctx.fillStyle = pal.lip;
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Lip edge: a faint player-colour line so the slab reads as solid.
    ctx.strokeStyle = pal.lipEdge;
    ctx.lineWidth   = Math.max(1, r * 0.03);
    ctx.stroke();

    // Rim with neon glow (the glow is what makes ownership readable at a glance).
    this._hexPath(ctx, x, y, r - rimW / 2);
    ctx.shadowColor = picked ? AMBER : selected ? '#ffffff' : pal.rim;
    ctx.shadowBlur  = shade ? r * 0.12 : (selected || picked) ? r * 0.58 : r * 0.29;
    ctx.strokeStyle = pal.rim;
    ctx.lineWidth   = rimW;
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur  = 0;

    // Face: dark radial gradient, lit from above.
    const face = ctx.createRadialGradient(x, y - r * 0.35, r * 0.05, x, y, r);
    face.addColorStop(0, FACE_HI);
    face.addColorStop(1, FACE_LO);
    this._hexPath(ctx, x, y, r - rimW);
    ctx.fillStyle = face;
    ctx.fill();

    // Inner bevel: light catches the upper inside edges, shadow on the lower ones.
    const inner = r - rimW - Math.max(0.75, r * 0.02);
    ctx.lineWidth = Math.max(1, r * 0.035);
    ctx.strokeStyle = 'rgba(255,255,255,.20)';
    this._hexEdges(ctx, x, y, inner, [3, 4, 5]);   // upper-left, top, upper-right
    ctx.stroke();
    ctx.strokeStyle = 'rgba(0,0,0,.45)';
    this._hexEdges(ctx, x, y, inner, [0, 1, 2]);   // lower edges
    ctx.stroke();

    // Specular line along the top of the rim.
    ctx.strokeStyle = picked ? '#fff4d1' : selected ? 'rgba(255,255,255,.9)' : pal.rimHi;
    ctx.lineWidth   = Math.max(0.75, rimW * 0.28);
    this._hexEdges(ctx, x, y, r - rimW * 0.62, [3, 4, 5]);
    ctx.stroke();

    // Buried slabs: darken everything drawn above.
    if (shade > 0) {
      this._hexPath(ctx, x, y + lipDy * 0.5, r + 1);
      ctx.fillStyle = `rgba(4,4,12,${(shade * 0.7).toFixed(3)})`;
      ctx.fill();
    }

    ctx.restore();
  }

  /**
   * Draw piece glyphs (sprites, or PNG/emoji fallbacks) plus stack badges for
   * `faces` (board space) onto a glyph context whose transform maps screen CSS
   * px. Used for the glyph layer and for live loose pieces on #emoji-layer.
   * @param {Map<*, {x:number, y:number, r:number, stack:Array}>} faces
   */
  _drawGlyphs(ec, faces) {
    ec.globalAlpha  = 1;
    ec.shadowBlur   = 0;
    ec.shadowColor  = 'transparent';
    ec.textAlign    = 'center';
    ec.textBaseline = 'middle';

    const s = this.scale;
    for (const face of faces.values()) {
      const { stack } = face;
      const sx = this.tx + face.x * s;
      const sy = this.ty + face.y * s;
      const r  = face.r * s;
      this._drawPieceVisual(ec, stack.at(-1), sx, sy, r * GLYPH_BOX);
      if (stack.length > 1) this._drawStackBadge(ec, stack, sx, sy, r);
    }
  }

  /**
   * Stack height cue, sized by badgeLayout(r): at normal zoom a "×N" pill on the
   * upper right plus a chip per buried piece (owner rim, species glyph) along
   * the lower rim; zoomed out, one small numeral disc in the upper-right corner.
   */
  _drawStackBadge(ec, stack, sx, sy, r) {
    const B = badgeLayout(r);
    if (B.mode === 'none') return;
    const topIdx = stack.length - 1;
    const topRim = (TILE[stack[topIdx].player] ?? TILE[1]).rim;

    if (B.mode === 'compact') {
      const cx = sx + B.chipDist * Math.cos(B.angle);
      const cy = sy + B.chipDist * Math.sin(B.angle);
      ec.beginPath();
      ec.arc(cx, cy, B.chipR, 0, Math.PI * 2);
      ec.fillStyle = 'rgba(7,7,15,.94)';
      ec.fill();
      ec.lineWidth = Math.max(0.75, B.chipR * 0.18);
      ec.strokeStyle = topRim;
      ec.stroke();
      ec.font = `${B.font.toFixed(1)}px 'Press Start 2P', monospace`;
      ec.fillStyle = '#ffffff';
      ec.fillText(String(stack.length), cx + B.font * 0.06, cy + B.font * 0.08);
      return;
    }

    // Buried-piece chips, nearest-to-top first, fanning clockwise around the lower rim.
    for (let i = topIdx - 1, n = 0; i >= 0; i--, n++) {
      const a  = B.angle + n * B.step;
      const cx = sx + B.chipDist * Math.cos(a);
      const cy = sy + B.chipDist * Math.sin(a);
      const pal = TILE[stack[i].player] ?? TILE[1];
      this._hexPath(ec, cx, cy, B.chipR);
      ec.fillStyle = FACE_LO;
      ec.fill();
      ec.lineWidth = Math.max(1, B.chipR * 0.2);
      ec.lineJoin = 'round';
      ec.strokeStyle = pal.rim;
      ec.stroke();
      this._drawPieceVisual(ec, stack[i], cx, cy, B.chipR * 1.9);
    }

    // ×N pill.
    const font = B.font;
    const label = `×${stack.length}`;
    ec.font = `${font}px 'Press Start 2P', monospace`;
    const w  = ec.measureText(label).width + font * 0.9;
    const h  = font * 1.7;
    const px = sx + B.pillX, py = sy + B.pillY;
    ec.beginPath();
    if (ec.roundRect) ec.roundRect(px - w / 2, py - h / 2, w, h, h / 2);
    else ec.rect(px - w / 2, py - h / 2, w, h);
    ec.fillStyle = 'rgba(7,7,15,.94)';
    ec.fill();
    ec.lineWidth = Math.max(1, font * 0.16);
    ec.strokeStyle = topRim;
    ec.stroke();
    ec.fillStyle = '#ffffff';
    ec.fillText(label, px + font * 0.06, py + font * 0.08);
  }

  _drawPieceVisual(ctx, piece, x, y, size) {
    if (piece.image?.complete && piece.image.naturalWidth) {
      const box   = size * 0.7; // PNG art fills its whole box; sprites only ~78% of theirs
      const ratio = Math.min(box / piece.image.naturalWidth, box / piece.image.naturalHeight);
      const width = piece.image.naturalWidth * ratio;
      const height = piece.image.naturalHeight * ratio;
      ctx.drawImage(piece.image, x - width / 2, y - height / 2, width, height);
      return;
    }

    const ink = SPECIES_COLOR[piece.type] ?? '#ffffff';
    if (drawSprite(ctx, piece.type, x, y, size, { ink, fill: bodyFill(ink), glow: ink })) return;

    // Last resort (no Path2D): the piece's emoji.
    ctx.font = `${Math.round(size * 0.45)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", serif`;
    ctx.fillStyle = '#ffffff';
    ctx.fillText(piece.emoji ?? '?', x, y);
  }

  /**
   * Build a flat-top hexagon path centred at (cx, cy) with given circumradius.
   * Caller must stroke/fill after calling this.
   */
  _hexPath(ctx, cx, cy, size) {
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i; // flat-top: 0°, 60°, 120°…
      const x = cx + size * Math.cos(a);
      const y = cy + size * Math.sin(a);
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  /**
   * Path of selected edges of a flat-top hexagon. Edge i runs from vertex i to
   * vertex i+1 (vertex 0 at east, clockwise in screen space): 0 lower-right,
   * 1 bottom, 2 lower-left, 3 upper-left, 4 top, 5 upper-right.
   */
  _hexEdges(ctx, cx, cy, size, edges) {
    ctx.beginPath();
    for (const e of edges) {
      const a0 = (Math.PI / 3) * e, a1 = (Math.PI / 3) * (e + 1);
      ctx.moveTo(cx + size * Math.cos(a0), cy + size * Math.sin(a0));
      ctx.lineTo(cx + size * Math.cos(a1), cy + size * Math.sin(a1));
    }
  }

  // ── Coordinate conversion ──────────────────────────────

  /**
   * Convert a screen (clientX/Y) point to the nearest hex coords.
   * @returns {{ q: number, r: number }}
   */
  screenToHex(sx, sy) {
    const bx = (sx - this.tx) / this.scale;
    const by = (sy - this.ty) / this.scale;
    return pixelToHex(bx, by, this.SIZE);
  }

  // ── Pointer / touch input ──────────────────────────────

  _bindEvents() {
    const c = this.canvas;

    c.addEventListener('pointerdown', e => {
      e.preventDefault();
      this.onHover?.(null);
      this._camera = null; // user takes over the camera
      c.setPointerCapture(e.pointerId);
      this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pts.size === 1) {
        this._dragOrigin = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        this._hasMoved   = false;
        this._multi      = false;
      }
      if (this._pts.size === 2) {
        this._multi      = true;  // a pinch is never a tap
        this._pinchLast  = this._pinchDist();
        this._dragOrigin = null; // disable single-pointer pan while pinching
      }
    });

    c.addEventListener('pointermove', e => {
      e.preventDefault();
      if (!this._pts.has(e.pointerId)) {
        if (e.pointerType === 'mouse' && this.onHover) {
          const { q, r } = this.screenToHex(e.clientX, e.clientY);
          this.onHover(q, r, e.clientX, e.clientY);
        }
        return;
      }
      this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pts.size >= 2) {
        // Pinch-zoom
        const d = this._pinchDist();
        if (this._pinchLast > 0) {
          const mid = this._pinchMid();
          this._applyZoom(d / this._pinchLast, mid.x, mid.y);
        }
        this._pinchLast = d;
        return;
      }

      if (this._dragOrigin) {
        const dx = e.clientX - this._dragOrigin.x;
        const dy = e.clientY - this._dragOrigin.y;
        if (this._hasMoved || Math.hypot(dx, dy) > 6) {
          if (!this._hasMoved) this.onViewChange?.();
          this._hasMoved = true;
          this.tx = this._dragOrigin.tx + dx;
          this.ty = this._dragOrigin.ty + dy;
        }
      }
    });

    const release = e => {
      this._pts.delete(e.pointerId);
      this._pinchLast = 0;

      if (this._pts.size === 1) {
        // Pinch ended with one finger still down: continue as a pan from here.
        const [rest] = this._pts.values();
        this._dragOrigin = { x: rest.x, y: rest.y, tx: this.tx, ty: this.ty };
        this._hasMoved   = true;
      }
      // Clear drag state BEFORE any onTap callback.
      // onTap triggers synchronous DOM updates (tray re-render, syncUI) which can
      // dispatch pointermove events while _dragOrigin is still set, locking the board.
      if (this._pts.size === 0) {
        this._dragOrigin = null;
        this._hasMoved   = false;
        this._multi      = false;
      }
    };

    c.addEventListener('pointerup', e => {
      e.preventDefault();
      const isTap = !this._hasMoved && !this._multi && this._pts.size === 1;
      release(e);
      if (isTap && this.onTap) {
        const { q, r } = this.screenToHex(e.clientX, e.clientY);
        this.onTap(q, r, e.clientX, e.clientY);
      }
    });

    c.addEventListener('pointercancel', release);
    c.addEventListener('pointerleave', () => this.onHover?.(null));

    // Desktop scroll-wheel / trackpad zoom
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this.onHover?.(null);
      this._camera = null;
      this.onViewChange?.();
      const delta = Math.max(-120, Math.min(120, e.deltaY));
      this._applyZoom(Math.exp(-delta * 0.0015), e.clientX, e.clientY);
    }, { passive: false });
  }

  _applyZoom(ratio, cx, cy) {
    const next  = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * ratio));
    const actual = next / this.scale;
    this.tx     = cx + (this.tx - cx) * actual;
    this.ty     = cy + (this.ty - cy) * actual;
    this.scale  = next;
  }

  _pinchDist() {
    const [a, b] = [...this._pts.values()];
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  _pinchMid() {
    const [a, b] = [...this._pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  }
}
