import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const KEY_LENGTH = 32;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, KEY_LENGTH, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, key] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !key) return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, {
    N: Number(N),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(actual, expected);
}

// Sessions live in memory, so a restart signs everyone out and nothing session-related is ever written to disk.
// Each session remembers the device it signed in on, and onExpire is told when one runs out so its Spruce token can be revoked.
export function createSessions({ ttlMs = 12 * 60 * 60 * 1000, now = Date.now, onExpire = () => {} } = {}) {
  const sessions = new Map();
  // Removes every session past its expiry and returns what onExpire returned for each.
  const sweep = () => {
    const results = [];
    for (const [id, session] of sessions) {
      if (session.expiresAt > now()) continue;
      sessions.delete(id);
      results.push(onExpire(session));
    }
    return results;
  };
  return {
    sweep,
    create(patientId, deviceId) {
      sweep();
      const id = randomBytes(32).toString('base64url');
      sessions.set(id, { id, patientId, deviceId, expiresAt: now() + ttlMs });
      return id;
    },
    get(id) {
      const session = id ? sessions.get(id) : undefined;
      if (!session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(id);
        onExpire(session);
        return null;
      }
      return session;
    },
    destroy(id) {
      sessions.delete(id);
    },
    // Reports whether a live session of the patient is signed in on the device.
    usesDevice(patientId, deviceId) {
      for (const session of sessions.values()) {
        if (session.patientId === patientId && session.deviceId === deviceId && session.expiresAt > now()) return true;
      }
      return false;
    },
  };
}

// Counts sign-in attempts per key and refuses further ones once the limit is reached inside the window.
export function createThrottle({ limit = 5, windowMs = 15 * 60 * 1000, now = Date.now } = {}) {
  const failures = new Map();
  const current = (key) => {
    const entry = failures.get(key);
    if (entry && entry.resetAt <= now()) {
      failures.delete(key);
      return undefined;
    }
    return entry;
  };
  return {
    blocked: (key) => (current(key)?.count ?? 0) >= limit,
    fail(key) {
      for (const [other, entry] of failures) if (entry.resetAt <= now()) failures.delete(other);
      const entry = current(key) ?? { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      failures.set(key, entry);
    },
    clear: (key) => failures.delete(key),
  };
}

export function newDeviceId() {
  return randomBytes(16).toString('base64url');
}
