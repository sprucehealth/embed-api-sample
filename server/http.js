import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

// An error whose status, type and message are safe to return to the browser.
export class HttpError extends Error {
  constructor(status, type, message) {
    super(message);
    this.status = status;
    this.type = type;
  }
}

const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function setSecurityHeaders(res) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
}

export function createRouter() {
  const routes = [];
  return {
    add(method, pattern, handler, options = {}) {
      routes.push({ method, parts: pattern.split('/').filter(Boolean), handler, options });
    },
    // Returns the matching route and its decoded path parameters, or null.
    match(method, pathname) {
      const segments = pathname.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== method || route.parts.length !== segments.length) continue;
        const params = {};
        let matched = true;
        for (let i = 0; i < segments.length; i++) {
          const part = route.parts[i];
          if (part.startsWith(':')) {
            try {
              params[part.slice(1)] = decodeURIComponent(segments[i]);
            } catch {
              matched = false;
            }
          } else if (part !== segments[i]) {
            matched = false;
          }
          if (!matched) break;
        }
        if (matched) return { route, params };
      }
      return null;
    },
  };
}

// Buffers the request body and refuses anything larger than the limit.
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      reject(new HttpError(413, 'too_large', 'The request body is too large.'));
      return;
    }
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      // Past the limit the rest of the body is read and discarded, which leaves the connection able to carry the 413.
      if (size > limit) {
        chunks.length = 0;
        reject(new HttpError(413, 'too_large', 'The request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJson(req, limit = 64 * 1024) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Send application/json.');
  const body = await readBody(req, limit);
  try {
    const value = JSON.parse(body.toString('utf8'));
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'invalid_input', 'The request body is not a JSON object.');
  }
}

export function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function sendError(res, status, type, message) {
  sendJson(res, status, { statusCode: status, type, message });
}

// Serves a file from the root directory, refusing dotfiles and any path that resolves outside the root.
export async function serveStatic(root, pathname, req, res) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return false;
  }
  if (decoded.includes('\0') || decoded.split('/').some((segment) => segment.startsWith('.'))) return false;
  if (decoded.endsWith('/')) decoded += 'index.html';
  const file = path.join(root, decoded);
  if (file !== root && !file.startsWith(root + path.sep)) return false;
  const type = MIME_TYPES[path.extname(file)];
  if (!type) return false;
  let info;
  try {
    info = await stat(file);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  createReadStream(file).pipe(res);
  return true;
}

export function parseCookies(req) {
  const cookies = {};
  for (const pair of String(req.headers.cookie ?? '').split(';')) {
    const index = pair.indexOf('=');
    if (index < 0) continue;
    cookies[pair.slice(0, index).trim()] = pair.slice(index + 1).trim();
  }
  return cookies;
}

export function appendCookie(res, name, value, { maxAgeSeconds } = {}) {
  // Secure is omitted because the sample is served over plain http on loopback; a deployed app must add it.
  let cookie = `${name}=${value}; Path=/; HttpOnly; SameSite=Strict`;
  if (maxAgeSeconds !== undefined) cookie += `; Max-Age=${maxAgeSeconds}`;
  const existing = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', existing ? [].concat(existing, cookie) : [cookie]);
}
