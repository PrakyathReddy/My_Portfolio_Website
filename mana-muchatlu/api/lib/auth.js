/**
 * Auth primitives for Mana Muchatlu.
 *
 * Deliberately dependency-free: Node's built-in crypto only, so the Lambda
 * deploys as a bare .zip with no npm install step in CI.
 *
 * Passphrases are stored as scrypt hashes (never plaintext, never reversible).
 * Sessions are HMAC-SHA256 signed tokens - stateless, so there is no session
 * table to keep, and revocation is done by rotating SESSION_SECRET.
 */

const crypto = require('crypto');

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days - this is a journal, not a bank
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function b64url(input) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(input) {
  return Buffer.from(String(input).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/**
 * Hash a passphrase for storage. Run this locally (see scripts/hash-passphrase.js)
 * and put the result in SSM - the plaintext never goes anywhere near the repo.
 */
function hashPassphrase(passphrase) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(passphrase, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/**
 * Constant-time passphrase check. Returns false for any malformed stored hash
 * rather than throwing, so a bad SSM value can't turn into a 500.
 */
function verifyPassphrase(passphrase, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  if (!Number.isInteger(N) || N < 1024 || (N & (N - 1)) !== 0) return false;

  const salt = fromB64url(parts[2].replace(/-/g, '+').replace(/_/g, '/'));
  const expected = Buffer.from(parts[3], 'base64');
  if (salt.length === 0 || expected.length === 0) return false;

  let actual;
  try {
    actual = crypto.scryptSync(passphrase, salt, expected.length, {
      N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    });
  } catch {
    return false;
  }

  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function signToken(claims, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) throw new Error('signToken requires a secret');
  const payload = { ...claims, iat: nowSeconds, exp: nowSeconds + TOKEN_TTL_SECONDS };
  const encoded = b64url(JSON.stringify(payload));
  const signature = b64url(crypto.createHmac('sha256', secret).update(encoded).digest());
  return `${encoded}.${signature}`;
}

/**
 * Verify a session token. Returns the claims, or null for anything suspect -
 * bad shape, bad signature, or expired. Callers only need the null check.
 */
function verifyToken(token, secret, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!secret) return null;

  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  const [encoded, signature] = parts;
  if (!encoded || !signature) return null;

  const expected = b64url(crypto.createHmac('sha256', secret).update(encoded).digest());
  const given = Buffer.from(signature);
  const want = Buffer.from(expected);
  if (given.length !== want.length || !crypto.timingSafeEqual(given, want)) return null;

  let claims;
  try {
    claims = JSON.parse(fromB64url(encoded).toString('utf8'));
  } catch {
    return null;
  }

  if (!claims || typeof claims !== 'object') return null;
  if (typeof claims.exp !== 'number' || claims.exp <= nowSeconds) return null;
  if (typeof claims.sub !== 'string' || !claims.sub) return null;

  return claims;
}

/** Pull a bearer token out of the headers, case-insensitively. */
function bearerFrom(headers) {
  const raw = headers || {};
  const key = Object.keys(raw).find((k) => k.toLowerCase() === 'authorization');
  if (!key) return null;
  const match = /^Bearer\s+(.+)$/i.exec(String(raw[key]).trim());
  return match ? match[1] : null;
}

/**
 * Parse the MEMBERS env var: a JSON array of the (two) people who can write.
 * Kept as config rather than a table - the member list changes approximately
 * never, and this keeps the whole app at one DynamoDB table.
 */
function parseMembers(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  return parsed
    .filter((m) => m && typeof m.id === 'string' && m.id)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === 'string' && m.name ? m.name : m.id,
      initials: typeof m.initials === 'string' && m.initials ? m.initials.slice(0, 2) : m.id.slice(0, 1).toUpperCase(),
      avatar: typeof m.avatar === 'string' ? m.avatar : '',
      accent: typeof m.accent === 'string' && m.accent ? m.accent : '#8b7355',
      passphraseHash: typeof m.passphraseHash === 'string' ? m.passphraseHash : '',
    }));
}

/** The member list minus anything secret - safe to hand to the browser. */
function publicMembers(members) {
  return members.map(({ passphraseHash, ...rest }) => rest);
}

module.exports = {
  TOKEN_TTL_SECONDS,
  hashPassphrase,
  verifyPassphrase,
  signToken,
  verifyToken,
  bearerFrom,
  parseMembers,
  publicMembers,
};
