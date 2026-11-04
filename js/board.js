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
    const faces = this._drawPieces(ctx, t);
    this._drawSelectionRing(ctx, t);
    this._drawLastMoveRing(ctx);
    this._drawGhosts(ctx, t, faces); // drawn after pieces so ghost rings overlay beetle targets

    ctx.restore();

    // Emoji rendered on a completely separate canvas — zero shared state
    this._drawEmojis(faces);
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

  _drawGhosts(ctx, t, faces = new Map()) {
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

      // Occupied target (beetle climb): tint the tile face so it reads through the rim.
      if (isOccupied) this._tintFace(ctx, faces.get(key), '57,255,20', pulse);

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
      this._tintFace(ctx, faces.get(key), '255,179,0', amberPulse);
      ctx.shadowBlur  = 20;
      ctx.shadowColor = AMBER;
      ctx.strokeStyle = AMBER;
      ctx.lineWidth   = 3.5;
      ctx.lineJoin    = 'round';
      ctx.globalAlpha = amberPulse;
      this._hexPath(ctx, p.x, p.y, this.SIZE + 3);
      ctx.stroke();
      ctx.restore();
    }
  }

  /**
   * Draw every stack as stepped 3D tiles. Stacks are painted back-to-front
   * (top row first) so a tile's lip and a raised stack overlap the row behind.
   * @returns {Map<string, {x:number, y:number, r:number}>} top-face geometry in
   *          board space, so the glyph layer lines up with lifts and pops.
   */
  _drawPieces(ctx, t) {
    const faces = new Map();
    const order = [...this.pieces.keys()].map(key => {
      const { q, r } = parseKey(key);
      return { key, p: hexToPixel(q, r, this.SIZE) };
    }).sort((a, b) => a.p.y - b.p.y || a.p.x - b.p.x);

    const tileR    = this.SIZE - 2;
    const selPulse = 0.5 + 0.5 * Math.sin(t / 240);

    for (const { key, p } of order) {
      const stack    = this.pieces.get(key);
      const selected = key === this.selectedHex;
      const layers   = stackLayers(stack.length, tileR);
      const topIdx   = stack.length - 1;
      const pop      = this._arrivalScale(key, t);

      for (let i = 0; i <= topIdx; i++) {
        const L     = layers[i];
        const isTop = i === topIdx;
        const lift  = isTop && selected ? tileR * 0.06 : 0;
        const x = p.x + L.dx, y = p.y + L.dy - lift;
        const r = tileR * L.scale * (isTop ? pop : 1);
        this._drawTile(ctx, x, y, r, stack[i].player, {
          shade: L.shade, selected: isTop && selected, selPulse, lift, t,
        });
        if (isTop) faces.set(key, { x, y, r });
      }
    }
    return faces;
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

  /** White pulsing ring outside the selected cell, drawn over every tile. */
  _drawSelectionRing(ctx, t) {
    if (!this.selectedHex || !this.pieces.has(this.selectedHex)) return;
    const { q, r } = parseKey(this.selectedHex);
    const p = hexToPixel(q, r, this.SIZE);
    const selPulse = 0.5 + 0.5 * Math.sin(t / 240);
    ctx.save();
    ctx.globalAlpha = 0.6 + 0.4 * selPulse;
    ctx.shadowBlur  = 10 + 16 * selPulse;
    ctx.shadowColor = '#ffffff';
    this._hexPath(ctx, p.x, p.y, this.SIZE + 5 + 3 * selPulse);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth   = 2.5;
    ctx.lineJoin    = 'round';
    ctx.stroke();
    ctx.restore();
  }

  /**
   * One tile: soft drop shadow, a player-tinted lip for thickness, a dark
   * bevelled face, a thick glowing rim in the owner's colour and a top-edge
   * highlight. `shade` (0..1) darkens buried slabs.
   */
  _drawTile(ctx, x, y, r, player, { shade = 0, selected = false, selPulse = 0, lift = 0, t = 0 }) {
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
    const idle = 0.5 + 0.5 * Math.sin(t / 900 + (player === 1 ? 0 : Math.PI));
    this._hexPath(ctx, x, y, r - rimW / 2);
    ctx.shadowColor = selected ? '#ffffff' : pal.rim;
    ctx.shadowBlur  = shade ? r * 0.12 : selected ? r * (0.45 + 0.25 * selPulse) : r * (0.26 + 0.06 * idle);
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
    ctx.strokeStyle = selected ? `rgba(255,255,255,${0.75 + 0.25 * selPulse})` : pal.rimHi;
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
   * Draw piece glyphs (sprites, or PNG/emoji fallbacks) plus stack badges on
   * the dedicated emojiCanvas — completely isolated from the board canvas
   * state. No animated fillStyle or globalAlpha bleed.
   * @param {Map<string, {x:number, y:number, r:number}>} faces from _drawPieces
   */
  _drawEmojis(faces) {
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

    const s = this.scale;
    for (const [key, face] of faces) {
      const stack = this.pieces.get(key);
      const sx = this.tx + face.x * s;
      const sy = this.ty + face.y * s;
      const r  = face.r * s;
      const topIdx = stack.length - 1;

      this._drawPieceVisual(ec, stack[topIdx], sx, sy, r * GLYPH_BOX);
      if (topIdx > 0) this._drawStackBadge(ec, stack, sx, sy, r);
    }
  }

  /**
   * Stack badge: a "×N" pill on the top tile's upper-right corner, and a chip
   * per buried piece (owner rim, species glyph) along the lower-right.
   */
  _drawStackBadge(ec, stack, sx, sy, r) {
    const topIdx = stack.length - 1;

    // Buried-piece chips, nearest-to-top first.
    const chipR = Math.max(5, r * 0.2);
    for (let i = topIdx - 1, n = 0; i >= 0; i--, n++) {
      const a  = Math.PI * (0.16 + n * 0.17); // fan clockwise from just below east
      const cx = sx + r * 0.96 * Math.cos(a);
      const cy = sy + r * 0.96 * Math.sin(a);
      const pal = TILE[stack[i].player] ?? TILE[1];
      ec.beginPath();
      ec.arc(cx, cy, chipR, 0, Math.PI * 2);
      ec.fillStyle = FACE_LO;
      ec.fill();
      ec.lineWidth = Math.max(1.2, chipR * 0.2);
      ec.strokeStyle = pal.rim;
      ec.stroke();
      this._drawPieceVisual(ec, stack[i], cx, cy, chipR * 2.1);
    }

    // ×N pill.
    const font = Math.max(7, Math.round(r * 0.2));
    const label = `\u00d7${stack.length}`;
    ec.font = `${font}px 'Press Start 2P', monospace`;
    const w  = ec.measureText(label).width + font * 0.9;
    const h  = font * 1.7;
    const px = sx + r * 0.5, py = sy - r * 0.8;
    ec.beginPath();
    if (ec.roundRect) ec.roundRect(px - w / 2, py - h / 2, w, h, h / 2);
    else ec.rect(px - w / 2, py - h / 2, w, h);
    ec.fillStyle = 'rgba(7,7,15,.94)';
    ec.fill();
    ec.lineWidth = Math.max(1, font * 0.16);
    ec.strokeStyle = (TILE[stack[topIdx].player] ?? TILE[1]).rim;
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
