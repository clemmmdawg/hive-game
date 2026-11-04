// sprites.js — Neon Bestiary insect sprites, shared by the DOM (inline SVG) and
// the board canvas (Path2D). All art lives on a 64×64 grid. Top-down with the head
// up, except the grasshopper, ant and mosquito, which read better side-on (head left).
//
// Every sprite has three layers, drawn in this order:
//   body — closed shapes: filled with the ink at ~40% over the dark page, then outlined
//   line — open strokes: legs, antennae, wing veins, plate edges
//   dot  — solid fills in the ink colour (fill-rule evenodd, so a shape drawn inside
//          another becomes a hole): eyes, stripes, marks, the ladybug's spotted dome
// Keeping one stroke width and one layer recipe is what makes the set read as a family.

export const GRID   = 64;
export const STROKE = 2.6;

/** Each species' glyph colour. Player ownership is shown by rims/frames, never the glyph. */
export const SPECIES_COLOR = Object.freeze({
  QUEEN:       '#ffd23f',
  BEETLE:      '#b07cff',
  GRASSHOPPER: '#a6ff3d',
  ANT:         '#4d8dff',
  SPIDER:      '#ff7a3d',
  MOSQUITO:    '#d8dcef',
  LADYBUG:     '#ff4040',
  PILLBUG:     '#2fe0a8',
});

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
      ...pair('M27 25C20 15 7 13 5 20C3 27 15 31 27 29Z'),     // forewings
      ...pair('M27 31C20 31 11 34 11.5 39C12 44 21 41 27 34Z'),  // hindwings
      'M29.6 56L32 62L34.4 56Z',                                // stinger
      ellipse(32, 45, 10, 12.5),                                // abdomen
      ellipse(32, 28.5, 7, 6),                                  // thorax
      circle(32, 18, 5.5),                                      // head
      'M25.5 13L24.5 5L28.8 8.6L32 3L35.2 8.6L39.5 5L38.5 13Z', // crown
    ],
    line: [
      ...pair('M24 22Q16 21 10 21.5'),                          // wing veins
      ...pair('M29 13.5Q26 10 22 10'),                          // antennae
    ],
    dot: [
      'M22.6 40.5Q32 43.5 41.4 40.5L41.9 44Q32 47 22.1 44Z',    // stripes
      'M22.3 48.5Q32 51.5 41.7 48.5L40.2 52.5Q32 55.5 23.8 52.5Z',
      circle(29.8, 18.4, 1.3), circle(34.2, 18.4, 1.3),         // eyes
    ],
  },

  BEETLE: {
    body: [
      ...pair('M31 27C21 27 15 34 15 43C15 52 22 58.5 31 59.5Z'), // split elytra
      'M20.5 27.5Q20.5 18 32 18Q43.5 18 43.5 27.5Z',            // pronotum
      'M26.5 18.5Q26.5 11 32 11Q37.5 11 37.5 18.5Z',            // head
    ],
    line: [
      ...pair('M29.5 12Q27 5.5 21 4.5'),                        // antennae
      ...pair('M21.5 23L14.5 20.5L13 13.5', 'M16 39L8.5 38L5.5 31.5', 'M18.5 51L12 54.5L11 61'), // legs
      ...pair('M21 35Q19 41 21 47'),                            // shell gloss
    ],
    dot: [circle(29.4, 15.2, 1.2), circle(34.6, 15.2, 1.2)],
  },

  // Side view, head left
  GRASSHOPPER: {
    body: [
      'M25 27L49 28Q58 30 60 35Q57 39 47 39L25 39Z',            // abdomen
      'M30.5 37Q29 31 39 23L48.5 13.5Q52.5 11 52 16L43 31Q38.5 39 30.5 37Z', // hind femur
      'M15.5 25Q23 20.5 30.5 24.5Q31.5 31 30 38Q23 41.5 16 37.5Z', // pronotum
      'M17.5 25.5Q13 20.5 8.5 23.5Q4.5 27 5.5 34Q7 41 12.5 41Q17.5 40 18 34Z', // head
    ],
    line: [
      'M31 28.5L55 31',                                         // wing edge
      'M35 31.5L45.5 20',                                       // femur ridge
      'M50.5 15.5L54.5 49.5L60 51.5',                           // hind tibia
      'M12.5 23Q15 12 27 6.5', 'M10.5 23.5Q8.5 13 14 6',        // antennae
      'M18.5 39L15 47L10 48.5', 'M26 39.5L25 48L20.5 51',       // front + mid legs
    ],
    dot: [circle(10.5, 29, 2.4)],                               // eye
  },

  // Side view, head left
  ANT: {
    body: [
      ellipse(47.5, 33, 11.5, 9),                               // gaster
      ellipse(36.5, 33.5, 2.6, 3.2),                            // petiole
      'M20.5 30Q23 25 29 26.5Q34.5 28 34.5 32.5Q32 37 25 36.5Q20 36 20.5 30Z', // thorax
      ellipse(12.5, 29, 7, 6.2),                                // head
    ],
    line: [
      'M6.5 32.5Q3 36 6.5 38.5',                                // mandible
      'M14 23L17 13L9.5 8',                                     // elbowed antenna
      'M23.5 35.5L17 41L13.5 50.5', 'M28 36.5L27.5 43L30 51', 'M32.5 35L39.5 41.5L44.5 50.5', // legs
      'M44.5 25Q41.5 33 44.5 41', 'M51 24.5Q48 33 51 41.5',     // gaster bands
    ],
    dot: [circle(11, 27.5, 1.7)],
  },

  SPIDER: {
    body: [
      ellipse(32, 42, 11.5, 13),                                // abdomen
      ellipse(32, 23, 7.5, 7),                                  // cephalothorax
    ],
    line: [
      ...pair('M29.5 16.5Q27.5 12.5 29.5 10'),                  // pedipalps
      ...pair('M26.5 19L18 11L18 2.5', 'M25 22.5L12.5 15L4 21',
              'M25 26L12.5 28.5L5.5 38', 'M27 28.5L19 34L14 47'), // 8 legs
    ],
    dot: [
      'M28.5 35L35.5 35L32 41L35.5 47L28.5 47L32 41Z',           // hourglass
      circle(29.6, 21, 1.2), circle(34.4, 21, 1.2),
    ],
  },

  // Side view, head left
  MOSQUITO: {
    body: [
      'M31 24Q41 13 56 11Q60.5 11.5 57 15Q46 20 33 27Z',        // far wing
      'M34 28Q46 26.5 58 31.5Q60.5 33.5 57 34.5Q46 35.5 34 33Z', // abdomen
      'M20 25Q26 18.5 33 22Q37.5 26 35.5 31Q30.5 35.5 23 33.5Q19 31.5 20 25Z', // thorax
      circle(15.5, 27.5, 5.5),                                  // head
      'M29 22Q37 9 51 5Q55.5 5 52.5 9Q42 15 31.5 25Z',          // near wing
    ],
    line: [
      'M11 30.5L2 41',                                          // proboscis
      'M13 22.5Q11 15 6 13', 'M15.5 22Q16 15 13 9.5',           // antennae
      'M33 21Q41 12.5 50.5 8', 'M41 30L41 33.5', 'M48 31L48 34.5', // wing vein, segments
      'M24 33.5L18.5 42L11 57', 'M28.5 34.5L29 45L24.5 59', 'M32.5 33L39 42L47 57', // long legs
    ],
    dot: [circle(14.5, 27, 2.6)],                               // compound eye
  },

  LADYBUG: {
    body: [
      'M32 23C44 23 51 31.5 51 41.5C51 52 42 59.5 32 59.5C22 59.5 13 52 13 41.5C13 31.5 20 23 32 23Z', // shell
      'M20 27.5Q21 17 32 17Q43 17 44 27.5Q38 24.5 32 24.5Q26 24.5 20 27.5Z', // pronotum
      'M26.5 17.5Q26.5 10.5 32 10.5Q37.5 10.5 37.5 17.5Z',      // head
    ],
    line: [
      ...pair('M29.5 11.5Q27.5 6 22.5 5'),                      // antennae
      ...pair('M15.5 32L9.5 28.5', 'M13.5 43L7 44', 'M16.5 53L11 57.5'), // legs
    ],
    dot: [
      // Solid domed shell with the spots and wing seam cut out (one path, evenodd)
      ['M32 25.5C42.5 25.5 48.5 33 48.5 41.5C48.5 50.5 41 57 32 57C23 57 15.5 50.5 15.5 41.5C15.5 33 21.5 25.5 32 25.5Z',
        'M31.1 25L32.9 25L32.9 58L31.1 58Z',
        circle(23.5, 34.5, 3.3), circle(40.5, 34.5, 3.3),
        circle(20.5, 45, 3), circle(43.5, 45, 3),
        circle(26.5, 52, 2.6), circle(37.5, 52, 2.6)].join(''),
      circle(26.5, 21.5, 1.8), circle(37.5, 21.5, 1.8),         // pronotum patches
    ],
  },

  PILLBUG: {
    body: [
      'M32 13C42 13 46 20 46 32C46 46 42 58 32 58C22 58 18 46 18 32C18 20 22 13 32 13Z', // shell
    ],
    line: [
      'M21 19Q32 15.5 43 19',                                   // head shield
      'M19.2 25Q32 21 44.8 25', 'M18.4 31Q32 27 45.6 31', 'M18.4 37Q32 33 45.6 37',
      'M19.2 43Q32 39 44.8 43', 'M20.6 49Q32 45 43.4 49', 'M23.5 54.5Q32 51 40.5 54.5', // plates
      ...pair('M27.5 14Q24 8 17.5 7.5'),                        // antennae
      ...pair('M28.5 57.5L27 61.5'),                            // uropods
      ...pair('M18.6 28L13.5 26.5', 'M18.2 34L13 34', 'M18.6 40L13.5 41.5', 'M19.6 46L15 49'), // legs
    ],
    dot: [],
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
 * Inline SVG markup. Pieces are painted in their species colour (inline style);
 * pass a `mono` class — or use a menu icon — to leave the colour to CSS `color`.
 * @param {string} type  PieceType or a menu icon ('CROWN', 'HOUSE', …)
 * @param {string} [cls] extra class names
 */
export function spriteSVG(type, cls = '') {
  const sprite = SPRITES[type];
  if (!sprite) return '';
  const layer = (name, paths, attrs = '') =>
    paths.length ? `<g class="sp-${name}"${attrs}>${paths.map(d => `<path d="${d}"/>`).join('')}</g>` : '';
  const species = /(^|\s)mono(\s|$)/.test(cls) ? null : SPECIES_COLOR[type];
  return `<svg class="sprite${cls ? ` ${cls}` : ''}" viewBox="0 0 ${GRID} ${GRID}" aria-hidden="true" focusable="false"`
    + `${species ? ` style="color:${species}"` : ''}>`
    + layer('body', sprite.body) + layer('line', sprite.line) + layer('dot', sprite.dot, ' fill-rule="evenodd"')
    + '</svg>';
}

// ── Canvas ────────────────────────────────────────────────────────────────

/** Opaque body fill for a sprite ink: 40% ink over #090916 (matches the CSS colour-mix). */
export function bodyFill(ink) {
  const base = [9, 9, 22];
  const rgb = [1, 3, 5].map((i, n) => Math.round(parseInt(ink.slice(i, i + 2), 16) * 0.4 + base[n] * 0.6));
  return `rgb(${rgb.join(',')})`;
}

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
 * @param {{ink:string, fill:string, glow?:string}} colors  ink = species colour (SPECIES_COLOR)
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
  ctx.fill(paths.dot, 'evenodd');
  ctx.restore();
  return true;
}
