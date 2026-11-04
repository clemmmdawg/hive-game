import test from 'node:test';
import assert from 'node:assert/strict';

import { PieceType } from '../js/game.js';
import { SPRITES, SPECIES_COLOR, spriteSVG, drawSprite, bodyFill } from '../js/sprites.js';

const PATH_DATA = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s-]+$/;

test('every piece type has a sprite with body, line and dot layers', () => {
  for (const type of Object.values(PieceType)) {
    const sprite = SPRITES[type];
    assert.ok(sprite, `${type} has a sprite`);
    assert.ok(sprite.body.length > 0, `${type} has body shapes`);
    for (const layer of ['body', 'line', 'dot']) {
      assert.ok(Array.isArray(sprite[layer]), `${type}.${layer} is an array`);
      for (const d of sprite[layer]) assert.match(d, PATH_DATA, `${type}.${layer} path is SVG path data`);
    }
  }
});

test('spriteSVG renders inline SVG with one path per shape', () => {
  const svg = spriteSVG(PieceType.SPIDER, 'tray-sprite');
  const sprite = SPRITES[PieceType.SPIDER];
  assert.match(svg, /^<svg class="sprite tray-sprite" viewBox="0 0 64 64" aria-hidden="true" focusable="false"[^>]*>/);
  assert.match(svg, /<\/svg>$/);
  const paths = svg.match(/<path d="/g).length;
  assert.equal(paths, sprite.body.length + sprite.line.length + sprite.dot.length);
});

test('spriteSVG returns an empty string for an unknown type', () => {
  assert.equal(spriteSVG('DRAGON'), '');
});

test('drawSprite reports false when Path2D is unavailable so callers can fall back', () => {
  assert.equal(typeof globalThis.Path2D, 'undefined');
  assert.equal(drawSprite({}, PieceType.ANT, 0, 0, 40, {}), false);
});

test('menu icons follow the same three-layer recipe as the pieces', () => {
  for (const type of ['CROWN', 'HOUSE', 'SIGNAL', 'GAMEPAD']) {
    const sprite = SPRITES[type];
    assert.ok(sprite, `${type} exists`);
    assert.ok(sprite.body.length > 0, `${type} has body shapes`);
    for (const layer of ['body', 'line', 'dot']) {
      for (const d of sprite[layer]) assert.match(d, PATH_DATA, `${type}.${layer} path is SVG path data`);
    }
  }
});

// ── Species colours ───────────────────────────────────────────────────────

const PLAYER_COLORS = { p1: '#ff2d78', p2: '#00f5ff' };
const rgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const rgbDistance = (a, b) => Math.hypot(...rgb(a).map((v, i) => v - rgb(b)[i]));

/** CIE76 ΔE in CIELAB (D65) — the spec's "ΔE ≈ 25" criterion. */
function deltaE(a, b) {
  const lab = hex => {
    const [r, g, bl] = rgb(hex).map(c => (c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    const f = t => t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116;
    const fx = f((0.4124 * r + 0.3576 * g + 0.1805 * bl) / 0.95047);
    const fy = f(0.2126 * r + 0.7152 * g + 0.0722 * bl);
    const fz = f((0.0193 * r + 0.1192 * g + 0.9505 * bl) / 1.08883);
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const [la, lb] = [lab(a), lab(b)];
  return Math.hypot(...la.map((v, i) => v - lb[i]));
}

test('SPECIES_COLOR gives every piece type its spec colour', () => {
  assert.deepEqual({ ...SPECIES_COLOR }, {
    QUEEN: '#ffd23f', BEETLE: '#b07cff', GRASSHOPPER: '#a6ff3d', ANT: '#4d8dff',
    SPIDER: '#ff7a3d', MOSQUITO: '#d8dcef', LADYBUG: '#ff4040', PILLBUG: '#2fe0a8',
  });
  for (const type of Object.values(PieceType)) assert.match(SPECIES_COLOR[type], /^#[0-9a-f]{6}$/, type);
});

test('no species colour can be mistaken for a player colour', () => {
  for (const [type, color] of Object.entries(SPECIES_COLOR)) {
    for (const [player, pc] of Object.entries(PLAYER_COLORS)) {
      assert.ok(deltaE(color, pc) > 25, `${type} vs ${player}: ΔE ${deltaE(color, pc).toFixed(1)}`);
      // Ladybug red is mandated by the spec and sits at RGB distance ~59 from P1
      // magenta (ΔE ~34, so it passes the spec's perceptual rule above).
      const floor = type === 'LADYBUG' && player === 'p1' ? 55 : 90;
      assert.ok(rgbDistance(color, pc) > floor, `${type} vs ${player}: RGB ${rgbDistance(color, pc).toFixed(1)}`);
    }
  }
});

test('spriteSVG paints pieces in their species colour', () => {
  for (const type of Object.values(PieceType)) {
    assert.ok(spriteSVG(type).includes(`style="color:${SPECIES_COLOR[type]}"`), type);
  }
});

test('spriteSVG leaves colour to CSS for mono sprites and menu icons', () => {
  assert.doesNotMatch(spriteSVG(PieceType.QUEEN, 'mono'), /style=/);
  assert.match(spriteSVG(PieceType.QUEEN, 'mono'), /^<svg class="sprite mono"/);
  for (const icon of ['CROWN', 'HOUSE', 'SIGNAL', 'GAMEPAD']) assert.doesNotMatch(spriteSVG(icon), /style=/, icon);
});

test('bodyFill mixes 40% of the ink over the dark page, like the CSS body fill', () => {
  assert.equal(bodyFill('#ffffff'), 'rgb(107,107,115)');
  assert.equal(bodyFill('#000000'), 'rgb(5,5,13)');
});
