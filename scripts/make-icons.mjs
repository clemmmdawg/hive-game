// Generates assets/icons/icon.svg (static, committed) and the PNG set from the
// in-game queen artwork. Usage: node scripts/make-icons.mjs
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SPRITES, SPECIES_COLOR, STROKE, GRID, bodyFill } from '../js/sprites.js';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'icons');
const BG = '#05050f';
const S = 512;
/** Round to 3 decimals so the generated SVG carries no float noise. */
const n = v => +v.toFixed(3);

/**
 * @param {{radius:number, simple?:boolean}} o  radius = hex circumradius in 512-unit space.
 *   simple drops glow/bevel and thickens strokes so it survives 32 px.
 */
export function iconSVG({ radius, simple = false }) {
  const c = S / 2;
  const hex = (r, sy = 1) => [0, 1, 2, 3, 4, 5]
    .map(i => `${(c + r * Math.cos(i * Math.PI / 3)).toFixed(2)},${(c + r * sy * Math.sin(i * Math.PI / 3)).toFixed(2)}`).join(' ');
  const ink = SPECIES_COLOR.QUEEN, q = SPRITES.QUEEN;
  const glyph = radius * (simple ? 1.36 : 1.32), k = glyph / GRID;
  const sw = STROKE * (simple ? 1.7 : 1);
  const tidy  = d => d.replace(/-?\d+\.\d{4,}/g, m => String(n(Number(m)))); // sprite arithmetic noise
  const paths = (a, extra = '') => a.map(d => `<path d="${tidy(d)}"${extra}/>`).join('');
  const rim = radius * (simple ? 0.14 : 0.09);
  const inner = radius - rim * 1.25;
  const defs = `<defs>
<linearGradient id="rim" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ff2d78"/><stop offset="0.5" stop-color="#b36bff"/><stop offset="1" stop-color="#00f5ff"/></linearGradient>
<radialGradient id="bg" cx=".5" cy=".42" r=".75"><stop offset="0" stop-color="#14122e"/><stop offset="1" stop-color="${BG}"/></radialGradient>
<radialGradient id="tile" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#1b1840"/><stop offset="1" stop-color="#0a0a1c"/></radialGradient>
<filter id="glow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${n(radius * 0.07)}"/></filter>
<filter id="gglow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="${n(radius * 0.04)}"/></filter>
</defs>`;
  const glyphG = (extra = '') => `<g transform="translate(${n(c - glyph / 2)} ${n(c - glyph / 2 + radius * 0.01)}) scale(${n(k)})"${extra}>`
    + `<g fill="${bodyFill(ink)}" stroke="${ink}" stroke-width="${n(sw)}" stroke-linejoin="round" stroke-linecap="round">${paths(q.body)}</g>`
    + `<g fill="none" stroke="${ink}" stroke-width="${n(sw)}" stroke-linejoin="round" stroke-linecap="round">${paths(q.line)}</g>`
    + `<g fill="${ink}" fill-rule="evenodd">${paths(q.dot)}</g></g>`;
  const body = simple
    ? `<polygon points="${hex(radius)}" fill="url(#rim)"/><polygon points="${hex(inner)}" fill="#0a0a1c"/>${glyphG()}`
    : `<polygon points="${hex(radius)}" fill="url(#rim)" filter="url(#glow)" opacity=".85"/>`
      + `<polygon points="${hex(radius)}" fill="url(#rim)"/>`
      + `<polygon points="${hex(inner)}" fill="url(#tile)"/>`
      + `<polygon points="${hex(inner * 0.93)}" fill="none" stroke="#ffffff" stroke-opacity=".07" stroke-width="${n(radius * 0.02)}"/>`
      + glyphG(' filter="url(#gglow)" opacity=".55"') + glyphG();
  // The favicon has no backdrop: transparent outside the hex sits well on light tab strips.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}" width="${S}" height="${S}">${defs}`
    + `${simple ? '' : `<rect width="${S}" height="${S}" fill="url(#bg)"/>`}${body}</svg>\n`;
}

const VARIANTS = {
  any:      iconSVG({ radius: 232 }),
  maskable: iconSVG({ radius: 186 }),   // circumradius < 0.4 * 512 = 204.8: inside the 80% safe circle
  favicon:  iconSVG({ radius: 244, simple: true }),
};
const PNGS = [
  ['icon-192.png', 'any', 192], ['icon-512.png', 'any', 512], ['icon-maskable-512.png', 'maskable', 512],
  ['apple-touch-icon-180.png', 'maskable', 180], ['favicon-32.png', 'favicon', 32],
];

async function loadPlaywright() {
  try { return (await import('/opt/node-tools/node_modules/playwright/index.js')).default; }
  catch { return (await import('playwright')).default; }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await writeFile(path.join(OUT, 'icon.svg'), VARIANTS.any);
  const pw = await loadPlaywright();
  const browser = await pw.chromium.launch();
  try {
    for (const [file, variant, size] of PNGS) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(`<html><body style="margin:0;background:transparent">${VARIANTS[variant].replace(/width="512" height="512"/, `width="${size}" height="${size}"`)}</body></html>`);
      const png = await page.screenshot({ type: 'png', omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
      await writeFile(path.join(OUT, file), png);
      await page.close();
      console.log(`wrote ${file} (${size}x${size})`);
    }
  } finally { await browser.close(); }
}
