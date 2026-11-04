// board.js — Canvas renderer + pointer input
// Depends on: hex.js (must load first)

import { hexToPixel, pixelToHex, hexNeighbors, hexKey, parseKey } from './hex.js';
import { drawSprite } from './sprites.js';

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

const SPRITE_SCALE = 1.5; // sprite art fills ~78% of its box; this sizes it to the hex
const SPRITE_COLORS = {
  1: { ink: '#ffd3e4', fill: '#2b0c1e', glow: P1 },
  2: { ink: '#d2fdff', fill: '#06262c', glow: P2 },
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

    this.reducedMotion = !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    this._camera  = null; // { from, to, start } while animating a recenter
    this._arrival = null; // { key, start } while a newly arrived piece pops in

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

  draw(t) {
    const ctx = this.ctx;
    const W = this.W, H = this.H;
    this._stepCamera(t);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    this._drawStars(ctx, W, H, t);

    // Board-space drawing
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    this._drawGridHints(ctx);
    this._drawLastMoveSource(ctx);
    const pops = this._drawPieces(ctx, t);
    this._drawLastMoveRing(ctx);
    this._drawGhosts(ctx, t); // drawn after pieces so ghost rings overlay beetle targets

    ctx.restore();

    // Emoji rendered on a completely separate canvas — zero shared state
    this._drawEmojis(pops);
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
    ctx.lineWidth = 1.5;
    this._hexPath(ctx, p.x, p.y, this.SIZE - 6);
    ctx.stroke();
    ctx.restore();
  }

  /** Gold corner ticks around the piece that moved last. */
  _drawLastMoveRing(ctx) {
    const lm = this.lastMove;
    if (!lm?.to || !this.pieces.has(lm.to)) return;
    const { q, r } = parseKey(lm.to);
    const p = hexToPixel(q, r, this.SIZE);
    const R = this.SIZE + 4;
    ctx.save();
    ctx.strokeStyle = GOLD;
    ctx.globalAlpha = 0.8;
    ctx.lineWidth   = 2;
    ctx.lineCap     = 'round';
    for (let i = 0; i < 6; i++) {
      const a = (Math.PI / 3) * i;
      const cx = p.x + R * Math.cos(a), cy = p.y + R * Math.sin(a);
      const a1 = a + (2 * Math.PI) / 3, a2 = a - (2 * Math.PI) / 3; // along the two edges
      ctx.beginPath();
      ctx.moveTo(cx + 9 * Math.cos(a1), cy + 9 * Math.sin(a1));
      ctx.lineTo(cx, cy);
      ctx.lineTo(cx + 9 * Math.cos(a2), cy + 9 * Math.sin(a2));
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawGhosts(ctx, t) {
    const pulse = 0.38 + 0.30 * Math.sin(t / 360);

    for (const key of this.ghosts) {
      const { q, r } = parseKey(key);
      const p = hexToPixel(q, r, this.SIZE);
      const isOccupied = this.pieces.has(key); // beetle can climb onto occupied hexes

      ctx.save();
      ctx.shadowBlur  = isOccupied ? 22 : 16;
      ctx.shadowColor = GHOST;

      if (!isOccupied) {
        // Empty target: fill + border + center dot
        this._hexPath(ctx, p.x, p.y, this.SIZE - 2);
        ctx.fillStyle = 'rgba(57,255,20,0.09)';
        ctx.fill();
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(57,255,20,0.55)';
        ctx.fill();
      }

      // For occupied targets, draw a slightly larger ring so it sits outside the piece hex
      const ringSize = isOccupied ? this.SIZE + 3 : this.SIZE - 2;
      ctx.strokeStyle = GHOST;
      ctx.lineWidth   = isOccupied ? 2.5 : 1.5;
      ctx.globalAlpha = pulse;
      this._hexPath(ctx, p.x, p.y, ringSize);
      ctx.stroke();
      ctx.restore();
    }

    // Throwable pieces: amber ring — signals "tap this to throw it"
    if (this.throwTargets.size === 0) return;
    const amberPulse = 0.50 + 0.38 * Math.sin(t / 310);

    for (const key of this.throwTargets) {
      const { q, r } = parseKey(key);
      const p = hexToPixel(q, r, this.SIZE);

      ctx.save();
      ctx.shadowBlur  = 20;
      ctx.shadowColor = AMBER;
      ctx.strokeStyle = AMBER;
      ctx.lineWidth   = 2.5;
      ctx.globalAlpha = amberPulse;
      this._hexPath(ctx, p.x, p.y, this.SIZE + 3);
      ctx.stroke();
      ctx.restore();
    }
  }

  /** Returns a Map of hex key → arrival scale so glyphs pop in sync. */
  _drawPieces(ctx, t) {
    const pops = new Map();
    for (const [key, stack] of this.pieces) {
      const { q, r } = parseKey(key);
      const p        = hexToPixel(q, r, this.SIZE);
      const selected = key === this.selectedHex;
      const topIdx   = stack.length - 1;
      const pop      = this._arrivalScale(key, t);
      if (pop !== 1) pops.set(key, pop);

      // Pyramid: draw bottom-to-top, each piece centered at the same (p.x, p.y).
      // Lower pieces use full SIZE; upper pieces shrink so lower ones form a visible frame.
      for (let i = 0; i <= topIdx; i++) {
        const piece   = stack[i];
        const isTop   = i === topIdx;
        const isP1    = piece.player === 1;
        const color   = isP1 ? P1 : P2;
        const fillRgb = isP1 ? '255,45,120' : '0,245,255';

        // Bottom piece: full size. Each layer above it shrinks by 35%.
        const hexR = (this.SIZE - 2) * Math.pow(0.65, topIdx - i) * (isTop ? pop : 1);

        const idlePulse = 0.28 + 0.06 * Math.sin(t / 900 + (isP1 ? 0 : Math.PI));
        const selPulse  = 0.50 + 0.50 * Math.sin(t / 240);
        const fillAlpha = (selected && isTop) ? (0.30 + 0.18 * selPulse)
                        : isTop               ? idlePulse
                        :                       0.50;
        const glowBlur  = (selected && isTop) ? (28 + 18 * selPulse)
                        : isTop               ? (10 + 6 * idlePulse)
                        :                       8;
        const strokeW   = (selected && isTop) ? (2.2 + 1.2 * selPulse)
                        : isTop               ? 1.8
                        :                       2.0; // bottom piece border slightly thicker

        ctx.save();

        // Dark base fill first (blocks starfield bleedthrough)
        ctx.shadowBlur = 0;
        this._hexPath(ctx, p.x, p.y, hexR);
        ctx.fillStyle  = '#09091a';
        ctx.fill();

        // Colored neon fill + glow
        ctx.shadowBlur  = glowBlur;
        ctx.shadowColor = (selected && isTop) ? '#ffffff' : color;
        this._hexPath(ctx, p.x, p.y, hexR);
        ctx.fillStyle   = `rgba(${fillRgb},${fillAlpha})`;
        ctx.fill();
        ctx.strokeStyle = (selected && isTop) ? '#ffffff' : color;
        ctx.lineWidth   = strokeW;
        ctx.stroke();

        // Inner bevel line for a little depth
        if (isTop) {
          ctx.shadowBlur  = 0;
          ctx.globalAlpha = 0.22;
          ctx.lineWidth   = 1;
          this._hexPath(ctx, p.x, p.y, hexR * 0.8);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // Selection ring (top piece only)
        if (selected && isTop) {
          ctx.globalAlpha = 0.35 + 0.65 * selPulse;
          ctx.shadowBlur  = 24 * selPulse;
          ctx.shadowColor = '#ffffff';
          this._hexPath(ctx, p.x, p.y, this.SIZE + 5 + 3 * selPulse);
          ctx.strokeStyle = '#ffffff';
          ctx.lineWidth   = 1.2;
          ctx.stroke();
        }

        ctx.restore();
      }
    }
    return pops;
  }

  /**
   * Draw all piece glyphs (sprites, or PNG/emoji fallbacks) on the dedicated
   * emojiCanvas — completely isolated from the board canvas state. No shadows,
   * no animated fillStyle, no globalAlpha bleed.
   */
  _drawEmojis(pops) {
    const ec = this.emojiCtx;

    ec.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ec.clearRect(0, 0, this.W, this.H);
    if (this.pieces.size === 0) return;

    ec.globalAlpha              = 1;
    ec.globalCompositeOperation = 'source-over';
    ec.shadowBlur               = 0;
    ec.shadowColor              = 'transparent';
    ec.textAlign                = 'center';
    ec.textBaseline             = 'middle';

    for (const [key, stack] of this.pieces) {
      const { x: sx, y: sy } = this.hexToScreen(key);
      const topIdx = stack.length - 1;
      const pop    = pops.get(key) ?? 1;

      // Top piece: always full-size, centered
      const visualSize = Math.round(this.SIZE * this.scale * 0.92 * pop);
      this._drawPieceVisual(ec, stack[topIdx], sx, sy, visualSize);

      // Buried pieces: badges fanned toward the lower-right, deeper = further out.
      if (topIdx > 0) {
        const badgeSize = Math.round(this.SIZE * this.scale * 0.34);

        for (let i = 0; i < topIdx; i++) {
          const depth   = topIdx - i; // 1 for just-below-top, higher for deeper
          const dist    = this.SIZE * this.scale * (0.44 + (depth - 1) * 0.20);
          const badgeSx = sx + dist * 0.60;
          const badgeSy = sy + dist * 0.58 + 1;

          // Dark disc in the owner's color keeps the badge legible over the glow
          ec.beginPath();
          ec.arc(badgeSx, badgeSy, badgeSize * 0.62, 0, Math.PI * 2);
          ec.fillStyle   = 'rgba(9,9,26,.92)';
          ec.fill();
          ec.lineWidth   = Math.max(1, badgeSize * 0.07);
          ec.strokeStyle = stack[i].player === 1 ? P1 : P2;
          ec.stroke();

          this._drawPieceVisual(ec, stack[i], badgeSx, badgeSy, badgeSize);
        }
      }
    }
  }

  _drawPieceVisual(ctx, piece, x, y, size) {
    if (piece.image?.complete && piece.image.naturalWidth) {
      const ratio = Math.min(size / piece.image.naturalWidth, size / piece.image.naturalHeight);
      const width = piece.image.naturalWidth * ratio;
      const height = piece.image.naturalHeight * ratio;
      ctx.drawImage(piece.image, x - width / 2, y - height / 2, width, height);
      return;
    }

    if (drawSprite(ctx, piece.type, x, y, size * SPRITE_SCALE, SPRITE_COLORS[piece.player] ?? SPRITE_COLORS[1])) return;

    // Last resort (no Path2D): the piece's emoji.
    ctx.font = `${Math.round(size * 0.64)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", serif`;
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
