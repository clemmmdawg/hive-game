// hex.js — Flat-top hexagon math utilities
// Axial coordinate system (q, r)
// No DOM or canvas dependencies — safe to reuse on the server.

const SQRT3 = Math.sqrt(3);

/**
 * Convert axial hex coords to canvas pixel position.
 * Origin (0,0) maps to pixel (0,0); caller applies viewport transform.
 */
function hexToPixel(q, r, size) {
  return {
    x: size * 1.5 * q,
    y: size * (SQRT3 * 0.5 * q + SQRT3 * r)
  };
}

/**
 * Convert pixel position (in board-space) to the nearest axial hex.
 */
function pixelToHex(px, py, size) {
  const q = (2 / 3 * px) / size;
  const r = (-1 / 3 * px + SQRT3 / 3 * py) / size;
  return hexRound(q, r);
}

/**
 * Round fractional axial coords to the nearest integer hex.
 */
function hexRound(fq, fr) {
  const fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr), s = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(s - fs);
  if      (dq > dr && dq > ds) q = -r - s;
  else if (dr > ds)             r = -q - s;
  return { q, r };
}

/**
 * Returns the 6 axial neighbors of a hex.
 */
function hexNeighbors(q, r) {
  return [
    { q: q + 1, r     }, { q: q - 1, r     },
    { q,        r: r+1 }, { q,        r: r-1 },
    { q: q + 1, r: r-1 }, { q: q - 1, r: r+1 }
  ];
}

/** Canonical string key for a hex. */
function hexKey(q, r) { return `${q},${r}`; }

/** Parse a hex key back to { q, r }. */
function parseKey(key) {
  const [q, r] = key.split(',').map(Number);
  return { q, r };
}

/**
 * Returns the 6 corner pixel points for a flat-top hex centred at (cx, cy).
 * Useful for custom path drawing outside the Board class.
 */
function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i; // 0°, 60°, 120° … flat-top
    pts.push({ x: cx + size * Math.cos(a), y: cy + size * Math.sin(a) });
  }
  return pts;
}

/**
 * Euclidean hex distance (number of steps between two hexes).
 */
function hexDistance(q1, r1, q2, r2) {
  const dq = q2 - q1, dr = r2 - r1;
  return (Math.abs(dq) + Math.abs(dq + dr) + Math.abs(dr)) / 2;
}

export { hexToPixel, pixelToHex, hexRound, hexNeighbors, hexKey, parseKey, hexCorners, hexDistance };
