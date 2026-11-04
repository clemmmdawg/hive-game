// sprites.js — Neon line-art insect sprites, shared by the DOM (inline SVG) and
// the board canvas (Path2D). All art lives on a 64×64 grid, top-down, head up.
//
// Every sprite has three layers, drawn in this order:
//   body — closed shapes: filled with a dark tint of the ink, then outlined
//   line — open strokes: legs, antennae, stripes, wing veins
//   dot  — solid fills in the ink colour: eyes and spots
// Keeping one stroke width and one layer recipe is what makes the set read as a family.

export const GRID   = 64;
export const STROKE = 2.6;

// ── Shape helpers (absolute coordinates, 64-grid) ─────────────────────────

const circle  = (cx, cy, r) => ellipse(cx, cy, r, r);
const ellipse = (cx, cy, rx, ry) =>
  `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${rx * 2} 0a${rx} ${ry} 0 1 0 ${-rx * 2} 0Z`;

/** Reflect an absolute M/L/Q/C/Z path across the vertical centre line. */
function mirror(d) {
  let axis = 0; // 0 = next number is x, 1 = y
  return d.replace(/[MLQCZ]|-?\d*\.?\d+/g, token => {
    if (/[A-Z]/.test(token)) { axis = 0; return token; }
    const out = axis === 0 ? String(+(GRID - Number(token)).toFixed(2)) : token;
    axis ^= 1;
    return out;
  });
}

/** A path and its mirror image, for left/right pairs. */
const pair = (...paths) => paths.flatMap(d => [d, mirror(d)]);

// ── The set ───────────────────────────────────────────────────────────────

export const SPRITES = {
  QUEEN: {
    body: [
      ...pair('M26 25C18 16 8 18 9 25C10 31 20 31 26 28Z'),    // wings
      ellipse(32, 43, 9, 12),                                 // abdomen
      ellipse(32, 27, 6.5, 5.5),                              // thorax
      circle(32, 17, 5.5),                                    // head
      'M27 11L28 5.5L30.5 8.5L32 4.5L33.5 8.5L36 5.5L37 11Z', // crown
    ],
    line: [
      'M23.8 38Q32 41 40.2 38', 'M23 44Q32 47 41 44', 'M24.7 50Q32 53 39.3 50', // stripes
      'M32 55L32 59',                                         // stinger
      ...pair('M27 31L21 36', 'M28 14Q24 11 21 12'),          // legs, antennae
    ],
    dot: [circle(29.6, 16.8, 1.3), circle(34.4, 16.8, 1.3)],
  },

  BEETLE: {
    body: [
      'M24 29L40 29Q46 32 45.5 44Q44 56 32 57Q20 56 18.5 44Q18 32 24 29Z', // shell
      'M22 24Q22 20 26 20L38 20Q42 20 42 24L42 26Q42 28 38 28L26 28Q22 28 22 26Z', // pronotum
      'M26 20Q26 12 32 12Q38 12 38 20Z',                                   // head
    ],
    line: [
      'M32 29L32 57',                                         // wing seam
      ...pair('M28.5 14Q25 8 28 3.5'),                        // horns
      ...pair('M22 25L15 22L11 16', 'M19.5 36L12 36L8 31', 'M20 47L13 51L10 57'), // legs
    ],
    dot: [circle(29, 16.5, 1.2), circle(35, 16.5, 1.2), circle(26, 37, 1.1), circle(38, 37, 1.1)],
  },

  GRASSHOPPER: {
    body: [
      ...pair('M27.5 24.5Q15 29 14.5 46Q17.5 50 21.5 46.5Q23.5 33 30 27.5Z'), // hind femurs
      'M26.5 26L37.5 26Q37 44 32 58Q27 44 26.5 26Z',          // abdomen
      'M27 17L37 17L38 26L26 26Z',                            // pronotum
      ellipse(32, 12, 4.5, 5),                                // head
    ],
    line: [
      ...pair('M28.5 28Q29.5 42 32 54'),                      // folded wings
      ...pair('M30 8C27 3 22 1 15 3'),                        // antennae
      ...pair('M16.5 48L21 59'),                              // hind tibiae
      ...pair('M27 19L21 16L19 11', 'M27 23L20 25L16 22'),    // front + mid legs
    ],
    dot: [circle(29.6, 11, 1.3), circle(34.4, 11, 1.3)],
  },

  ANT: {
    body: [
      ellipse(32, 47, 8, 10),                                 // gaster
      circle(32, 35.5, 2.2),                                  // petiole
      ellipse(32, 27, 4, 6),                                  // thorax
      circle(32, 14, 6),                                      // head
    ],
    line: [
      ...pair('M29.5 8.5Q30 5 32 5'),                         // mandibles
      ...pair('M28.5 10L24 3L18 5'),                          // elbowed antennae
      ...pair('M28.5 23L20 19L15 12', 'M28 27L18 28L12 25', 'M28.5 31L20 37L15 45'), // legs
      'M25 44Q32 46.5 39 44', 'M25.5 50Q32 52.5 38.5 50',     // gaster bands
    ],
    dot: [circle(28.8, 13.5, 1.2), circle(35.2, 13.5, 1.2)],
  },

  SPIDER: {
    body: [
      ellipse(32, 42, 10, 12),                                // abdomen
      circle(32, 22, 7),                                      // cephalothorax
    ],
    line: [
      'M27 38L32 42L37 38', 'M28 45L32 48L36 45',             // abdomen chevrons
      ...pair('M29.5 15.5L28 11'),                            // fangs
      ...pair('M26 18L16 10L12 3', 'M25.2 21L13 17L5 14', 'M25.2 24L13 29L6 34', 'M26.5 27L17 37L12 48'), // 8 legs
    ],
    dot: [circle(29.4, 19.5, 1.2), circle(34.6, 19.5, 1.2), circle(31, 17.3, 0.8), circle(33, 17.3, 0.8)],
  },

  MOSQUITO: {
    body: [
      ...pair('M28 23C20 26 14 36 15 44C16 46.5 19 45.5 21 42C24 36 27 29 28 23Z'), // wings
      ellipse(32, 42, 3.2, 13),                               // abdomen
      ellipse(32, 24, 4.5, 5),                                // thorax
      circle(32, 16, 3.5),                                    // head
    ],
    line: [
      'M32 12.5L32 2',                                        // proboscis
      ...pair('M30.5 13L26 7'),                               // antennae
      'M29.2 36L34.8 36', 'M29 42L35 42', 'M29.3 48L34.7 48', // segments
      ...pair('M27 27L19 40'),                                // wing veins
      ...pair('M28.5 21L20 14L14 4', 'M28 25L14 22L4 24', 'M29 28L20 40L10 58'), // long legs
    ],
    dot: [circle(30.2, 15.6, 1), circle(33.8, 15.6, 1)],
  },

  LADYBUG: {
    body: [
      'M32 17C44 17 51 26 51 37C51 48 43 56 32 56C21 56 13 48 13 37C13 26 20 17 32 17Z', // shell
      'M25.5 17.5Q25.5 10 32 10Q38.5 10 38.5 17.5Z',          // head
    ],
    line: [
      'M17.5 26Q32 21 46.5 26', 'M32 23.5L32 56',             // pronotum edge, wing seam
      ...pair('M29 11Q27 6 24 5'),                            // antennae
      ...pair('M16 30L10 27', 'M14.5 40L8 41', 'M17 49L11 53'), // legs
    ],
    dot: [
      circle(24.5, 32.5, 3), circle(39.5, 32.5, 3),
      circle(21.5, 42.5, 2.8), circle(42.5, 42.5, 2.8),
      circle(26.5, 50.5, 2.4), circle(37.5, 50.5, 2.4),
      circle(29.5, 14.5, 1), circle(34.5, 14.5, 1),
    ],
  },

  PILLBUG: {
    body: [ellipse(32, 35, 13, 21)],                          // segmented shell
    line: [
      'M22.9 20Q32 23 41.1 20', 'M20.3 26Q32 29.5 43.7 26', 'M19.2 32Q32 35.5 44.8 32',
      'M19.2 38Q32 41.5 44.8 38', 'M20.3 44Q32 47.5 43.7 44', 'M22.9 50Q32 53 41.1 50', // plates
      ...pair('M28.5 15C25 10 21 8 16 9'),                    // antennae
      ...pair('M29 55.5L27 59.5'),                            // uropods
      ...pair('M20.5 24L16 22', 'M19.1 31L14 30', 'M19.1 39L14 40', 'M20.5 46L16 48'), // legs
    ],
    dot: [circle(27.2, 17.5, 1.1), circle(36.8, 17.5, 1.1)],
  },

  // ── Not pieces: menu icons drawn to the same recipe so the UI matches the set ──

  HOUSE: { // LOCAL — pass & play
    body: [
      'M40 20L40 12L45.5 12L45.5 25Z',                        // chimney
      'M17 29L32 15.5L47 29L47 53L17 53Z',                    // walls
      'M26.5 53L26.5 42Q26.5 37 32 37Q37.5 37 37.5 42L37.5 53Z', // door
    ],
    line: ['M10 32L32 12L54 32', 'M12 53L52 53'],             // roof, ground
    dot: ['M35.2 27L33.6 29.8L30.4 29.8L28.8 27L30.4 24.2L33.6 24.2Z', circle(34.6, 46.5, 1.1)], // hex window, knob
  },

  SIGNAL: { // HOST — broadcast tower
    body: [circle(32, 25, 5.5)],                              // beacon
    line: [
      'M32 31L24 55', 'M32 31L40 55', 'M28.3 43L35.7 43', 'M26.3 50L37.7 50', // lattice mast
      'M19 55L45 55',                                         // base
      ...pair('M22.5 16Q18 25 22.5 34', 'M15.5 11Q8 25 15.5 39'), // radio waves
    ],
    dot: [circle(32, 25, 1.9)],
  },

  GAMEPAD: { // JOIN — hop into a friend's game
    body: ['M20 21L44 21Q54 21 56 33L57.5 42Q58.5 50 52 50Q48 50 45 45L42 40L22 40L19 45Q16 50 12 50Q5.5 50 6.5 42L8 33Q10 21 20 21Z'],
    line: ['M18 26.5L18 35.5', 'M13.5 31L22.5 31', 'M28.5 29L31 29', 'M33 29L35.5 29'], // d-pad, select/start
    dot: [circle(46, 26.5, 2), circle(50.5, 31, 2), circle(46, 35.5, 2), circle(41.5, 31, 2)],
  },

  // Tournament-rule toggle
  CROWN: {
    body: ['M10 46L13 20L24 33L32 13L40 33L51 20L54 46Z'],
    line: ['M12 53L52 53'],
    dot: [circle(13, 18, 2.5), circle(32, 11, 2.5), circle(51, 18, 2.5)],
  },
};

// ── DOM ───────────────────────────────────────────────────────────────────

/**
 * Inline SVG markup. Colour comes from CSS `color` (see .sprite in styles.css).
 * @param {string} type  PieceType or 'CROWN'
 * @param {string} [cls] extra class names
 */
export function spriteSVG(type, cls = '') {
  const sprite = SPRITES[type];
  if (!sprite) return '';
  const layer = (name, paths) =>
    paths.length ? `<g class="sp-${name}">${paths.map(d => `<path d="${d}"/>`).join('')}</g>` : '';
  return `<svg class="sprite${cls ? ` ${cls}` : ''}" viewBox="0 0 ${GRID} ${GRID}" aria-hidden="true" focusable="false">`
    + layer('body', sprite.body) + layer('line', sprite.line) + layer('dot', sprite.dot)
    + '</svg>';
}

// ── Canvas ────────────────────────────────────────────────────────────────

const _cache = new Map(); // type → { body: Path2D[], line: Path2D, dot: Path2D, outline: Path2D }

function compiled(type) {
  if (_cache.has(type)) return _cache.get(type);
  const sprite = SPRITES[type];
  if (!sprite) return null;
  const entry = {
    body:    sprite.body.map(d => new Path2D(d)),
    line:    new Path2D(sprite.line.join(' ')),
    dot:     new Path2D(sprite.dot.join(' ')),
    outline: new Path2D([...sprite.body, ...sprite.line].join(' ')),
  };
  _cache.set(type, entry);
  return entry;
}

/**
 * Draw a sprite centred at (x, y), `size` px square.
 * @param {{ink:string, fill:string, glow?:string}} colors
 * @returns {boolean} false when Path2D is unavailable (caller should fall back)
 */
export function drawSprite(ctx, type, x, y, size, { ink, fill, glow }) {
  if (typeof Path2D === 'undefined') return false;
  const paths = compiled(type);
  if (!paths) return false;

  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / GRID, size / GRID);
  ctx.lineCap  = 'round';
  ctx.lineJoin = 'round';

  // Soft neon halo: a wide, faint stroke under everything (cheaper than shadowBlur).
  if (glow) {
    ctx.globalAlpha = 0.35;
    ctx.strokeStyle = glow;
    ctx.lineWidth   = STROKE * 2.2;
    ctx.stroke(paths.outline);
    ctx.globalAlpha = 1;
  }

  ctx.lineWidth   = STROKE;
  ctx.strokeStyle = ink;
  for (const body of paths.body) {
    ctx.fillStyle = fill;
    ctx.fill(body);
    ctx.stroke(body);
  }
  ctx.stroke(paths.line);
  ctx.fillStyle = ink;
  ctx.fill(paths.dot);
  ctx.restore();
  return true;
}
