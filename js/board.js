// board.js — Canvas renderer + pointer input
// Depends on: hex.js (must load first)

import { hexToPixel, pixelToHex, hexNeighbors, hexKey, parseKey } from './hex.js';

export class Board {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas, emojiCanvas) {
    this.canvas      = canvas;
    this.ctx         = canvas.getContext('2d');
    this.emojiCanvas = emojiCanvas;
    this.emojiCtx    = emojiCanvas.getContext('2d');
    this.SIZE   = 50; // hex circumradius in board-space units

    // Viewport transform: board-space → screen-space
    this.tx    = 0;   // x translate (set by init())
    this.ty    = 0;   // y translate
    this.scale = 1;

    // ── Game data (written by app.js) ──
    /** @type {Map<string, {player:1|2, type:string, emoji:string}>} */
    this.pieces      = new Map();
    /** @type {Set<string>} hex keys to draw as placement/move targets */
    this.ghosts       = new Set();
    /** @type {Set<string>} hex keys of pieces the pillbug can throw (amber) */
    this.throwTargets = new Set();
    /** @type {string|null} hex key of the currently selected on-board piece */
    this.selectedHex = null;

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
    this._pinchLast  = 0;

    /** Callback fired on a clean tap: (q:number, r:number) => void */
    this.onTap = null;

    this._bindEvents();
  }

  // ── Setup ──────────────────────────────────────────────

  /** Call once after setting canvas dimensions. Centers the viewport. */
  init() {
    this.tx = this.canvas.width  / 2;
    this.ty = this.canvas.height / 2;
    this.emojiCanvas.width  = this.canvas.width;
    this.emojiCanvas.height = this.canvas.height;
  }

  /** Resize canvas; adjusts transform to keep the same board center visible. */
  resize(w, h) {
    const dw = w - (this.canvas.width  || w);
    const dh = h - (this.canvas.height || h);
    this.canvas.width       = w;
    this.canvas.height      = h;
    this.emojiCanvas.width  = w;
    this.emojiCanvas.height = h;
    this.tx += dw / 2;
    this.ty += dh / 2;
  }

  // ── Render loop ────────────────────────────────────────

  draw(t) {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;

    // Background
    ctx.fillStyle = '#05050f';
    ctx.fillRect(0, 0, W, H);

    this._drawStars(ctx, W, H, t);

    // Board-space drawing
    ctx.save();
    ctx.translate(this.tx, this.ty);
    ctx.scale(this.scale, this.scale);

    this._drawGridHints(ctx);
    this._drawPieces(ctx, t);
    this._drawGhosts(ctx, t); // drawn after pieces so ghost rings overlay beetle targets

    ctx.restore();

    // Emoji rendered on a completely separate canvas — zero shared state
    this._drawEmojis();
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
      ctx.strokeStyle = 'rgba(255,255,255,0.13)';
      ctx.lineWidth = 1;
      this._hexPath(ctx, 0, 0, this.SIZE - 2);
      ctx.stroke();
      ctx.restore();
      return;
    }

    // Faint outlines around every occupied hex's empty neighbors
    const shown = new Set();
    for (const key of this.pieces.keys()) {
      const { q, r } = parseKey(key);
      for (const n of hexNeighbors(q, r)) {
        const nk = hexKey(n.q, n.r);
        if (!this.pieces.has(nk) && !shown.has(nk)) {
          shown.add(nk);
          const p = hexToPixel(n.q, n.r, this.SIZE);
          ctx.strokeStyle = 'rgba(255,255,255,0.055)';
          ctx.lineWidth = 1;
          this._hexPath(ctx, p.x, p.y, this.SIZE - 2);
          ctx.stroke();
        }
      }
    }
  }

  _drawGhosts(ctx, t) {
    if (this.ghosts.size === 0) return;
    const pulse = 0.38 + 0.30 * Math.sin(t / 360);

    for (const key of this.ghosts) {
      const { q, r } = parseKey(key);
      const p = hexToPixel(q, r, this.SIZE);
      const isOccupied = this.pieces.has(key); // beetle can climb onto occupied hexes

      ctx.save();
      ctx.shadowBlur  = isOccupied ? 22 : 16;
      ctx.shadowColor = '#39ff14';

      if (!isOccupied) {
        // Empty target: fill + border
        this._hexPath(ctx, p.x, p.y, this.SIZE - 2);
        ctx.fillStyle = 'rgba(57,255,20,0.09)';
        ctx.fill();
      }

      // For occupied targets, draw a slightly larger ring so it sits outside the piece hex
      const ringSize = isOccupied ? this.SIZE + 3 : this.SIZE - 2;
      ctx.strokeStyle = '#39ff14';
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
      ctx.shadowColor = '#ffb300';
      ctx.strokeStyle = '#ffb300';
      ctx.lineWidth   = 2.5;
      ctx.globalAlpha = amberPulse;
      this._hexPath(ctx, p.x, p.y, this.SIZE + 3);
      ctx.stroke();
      ctx.restore();
    }
  }

  _drawPieces(ctx, t) {
    for (const [key, stack] of this.pieces) {
      const { q, r } = parseKey(key);
      const p        = hexToPixel(q, r, this.SIZE);
      const selected = key === this.selectedHex;
      const topIdx   = stack.length - 1;

      // Pyramid: draw bottom-to-top, each piece centered at the same (p.x, p.y).
      // Lower pieces use full SIZE; upper pieces shrink so lower ones form a visible frame.
      for (let i = 0; i <= topIdx; i++) {
        const piece   = stack[i];
        const depth   = topIdx - i;   // 0 = top piece, 1 = one below, etc.
        const isTop   = depth === 0;
        const isP1    = piece.player === 1;
        const color   = isP1 ? '#ff2d78'    : '#00f5ff';
        const fillRgb = isP1 ? '255,45,120' : '0,245,255';

        // Bottom piece: full size. Each layer above it shrinks by 30%.
        // depth 0 (top) = smallest; depth 1 (bottom of 2-stack) = full size.
        // For a 2-stack: bottom=SIZE-2, top=(SIZE-2)*0.65
        const hexR = (this.SIZE - 2) * Math.pow(0.65, topIdx - i);

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
  }

  /**
   * Draw all emoji on the dedicated emojiCanvas — completely isolated
   * from the board canvas state. No shadows, no animated fillStyle,
   * no globalAlpha bleed. This is the only guaranteed-clean solution.
   */
  _drawEmojis() {
    const ec = this.emojiCtx;
    const W  = this.emojiCanvas.width;
    const H  = this.emojiCanvas.height;

    ec.clearRect(0, 0, W, H);
    if (this.pieces.size === 0) return;

    ec.globalAlpha              = 1;
    ec.globalCompositeOperation = 'source-over';
    ec.shadowBlur               = 0;
    ec.shadowColor              = 'transparent';
    ec.textAlign                = 'center';
    ec.textBaseline             = 'middle';

    for (const [key, stack] of this.pieces) {
      const { q, r } = parseKey(key);
      const bp   = hexToPixel(q, r, this.SIZE);
      const sx   = this.tx + bp.x * this.scale;
      const sy   = this.ty + bp.y * this.scale;
      const topIdx = stack.length - 1;

      // Top piece: always full-size, centered
      const emojiSize = Math.round(this.SIZE * this.scale * 0.58);
      ec.font        = `${emojiSize}px serif`;
      ec.fillStyle   = '#ffffff';
      ec.globalAlpha = 1;
      ec.fillText(stack[topIdx].emoji, sx, sy + 1);

      // Buried pieces: badges arranged in the lower-right corner, bottom-to-top.
      // Each badge is placed slightly further from center so they fan out
      // and don't overlap each other.
      if (topIdx > 0) {
        const badgeSize = Math.round(this.SIZE * this.scale * 0.28);
        ec.font = `${badgeSize}px serif`;

        for (let i = 0; i < topIdx; i++) {
          // i=0 is the bottommost buried piece; i=topIdx-1 is just below the top.
          // Fan them out diagonally — deeper pieces sit further from center.
          const depth  = topIdx - i; // 1 for just-below-top, higher for deeper
          const dist   = this.SIZE * this.scale * (0.44 + (depth - 1) * 0.20);
          const badgeSx = sx + dist * 0.60;
          const badgeSy = sy + dist * 0.58;
          ec.fillText(stack[i].emoji, badgeSx, badgeSy + 1);
        }
      }
    }

    // Reset alpha
    ec.globalAlpha = 1;
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
      c.setPointerCapture(e.pointerId);
      this._pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

      if (this._pts.size === 1) {
        this._dragOrigin = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty };
        this._hasMoved   = false;
      }
      if (this._pts.size === 2) {
        this._pinchLast  = this._pinchDist();
        this._dragOrigin = null; // disable single-pointer pan while pinching
      }
    });

    c.addEventListener('pointermove', e => {
      e.preventDefault();
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
        if (Math.hypot(dx, dy) > 6) {
          this._hasMoved = true;
          this.tx = this._dragOrigin.tx + dx;
          this.ty = this._dragOrigin.ty + dy;
        }
      }
    });

    c.addEventListener('pointerup', e => {
      e.preventDefault();
      const isTap  = !this._hasMoved && this._pts.size === 1;
      const tapX   = e.clientX;
      const tapY   = e.clientY;

      this._pts.delete(e.pointerId);
      this._pinchLast = 0;

      // Clear drag state BEFORE firing onTap.
      // onTap triggers synchronous DOM updates (tray re-render, syncUI) which can
      // dispatch pointermove events while _dragOrigin is still set, locking the board.
      if (this._pts.size === 0) {
        this._dragOrigin = null;
        this._hasMoved   = false;
      }

      if (isTap && this.onTap) {
        const { q, r } = this.screenToHex(tapX, tapY);
        this.onTap(q, r);
      }
    });

    c.addEventListener('pointercancel', e => {
      this._pts.delete(e.pointerId);
    });

    // Desktop scroll-wheel zoom
    c.addEventListener('wheel', e => {
      e.preventDefault();
      this._applyZoom(e.deltaY < 0 ? 1.12 : 0.89, e.clientX, e.clientY);
    }, { passive: false });
  }

  _applyZoom(ratio, cx, cy) {
    const next  = Math.min(3.5, Math.max(0.2, this.scale * ratio));
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
