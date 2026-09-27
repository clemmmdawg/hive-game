import test from 'node:test';
import assert from 'node:assert/strict';

import { PieceType } from '../js/game.js';
import { SPRITES, spriteSVG, drawSprite } from '../js/sprites.js';

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
  assert.match(svg, /^<svg class="sprite tray-sprite" viewBox="0 0 64 64" aria-hidden="true" focusable="false">/);
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
