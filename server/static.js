/**
 * static.js — Maps request URLs to files the browser is allowed to fetch.
 *
 * Only the client bundle is public. Everything else in the repo (server code,
 * tests, .git, node_modules, docs) resolves to null and is served as a 404.
 */

import { posix } from 'path';

const PUBLIC_FILES = new Set(['/index.html', '/styles.css', '/manifest.json', '/sw.js', '/favicon.ico']);
const PUBLIC_DIRS  = ['/js/', '/assets/'];

/**
 * @param {string} root    - Absolute path of the project root
 * @param {string} rawUrl  - req.url, possibly with a query string
 * @returns {string|null}  - Absolute file path, or null when not public
 */
export function resolveStaticPath(root, rawUrl) {
  let urlPath = String(rawUrl).split('?')[0].split('#')[0];
  try { urlPath = decodeURIComponent(urlPath); } catch { return null; }
  if (urlPath.includes('\0') || urlPath.split('/').includes('..')) return null;

  urlPath = posix.normalize(urlPath);
  if (urlPath === '/') urlPath = '/index.html';

  const allowed = PUBLIC_FILES.has(urlPath) || PUBLIC_DIRS.some(dir => urlPath.startsWith(dir));
  return allowed ? posix.join(root, urlPath) : null;
}
