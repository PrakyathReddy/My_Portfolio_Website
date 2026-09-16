/**
 * Tests for the auth primitives.
 * These are the functions where a bug is silent and expensive, so they get
 * the most coverage in the project.
 */

const fc = require('fast-check');
const auth = require('../lib/auth');

describe('passphrase hashing', () => {
  // scrypt at N=16384 is deliberately slow; keep the sample counts low.
  jest.setTimeout(30000);

  test('accepts the correct passphrase', () => {
    const stored = auth.hashPassphrase('correct horse battery staple');
    expect(auth.verifyPassphrase('correct horse battery staple', stored)).toBe(true);
  });

  test('rejects the wrong passphrase', () => {
    const stored = auth.hashPassphrase('correct horse battery staple');
    expect(auth.verifyPassphrase('Correct horse battery staple', stored)).toBe(false);
    expect(auth.verifyPassphrase('', stored)).toBe(false);
  });

  test('produces a different hash each time (salted)', () => {
    const a = auth.hashPassphrase('same passphrase');
    const b = auth.hashPassphrase('same passphrase');
    expect(a).not.toEqual(b);
    // ...but both still verify.
    expect(auth.verifyPassphrase('same passphrase', a)).toBe(true);
    expect(auth.verifyPassphrase('same passphrase', b)).toBe(true);
  });

  test('never contains the plaintext passphrase', () => {
    const secret = 'shivani-and-prakyath-2026';
    expect(auth.hashPassphrase(secret)).not.toContain(secret);
  });

  test.each([
    ['empty string', ''],
    ['null', null],
    ['undefined', undefined],
    ['garbage', 'not-a-hash'],
    ['wrong algorithm', 'bcrypt$16384$c2FsdA==$aGFzaA=='],
    ['too few parts', 'scrypt$16384$c2FsdA=='],
    ['non-numeric N', 'scrypt$abc$c2FsdA==$aGFzaA=='],
    ['N below floor', 'scrypt$2$c2FsdA==$aGFzaA=='],
    ['N not a power of two', 'scrypt$16383$c2FsdA==$aGFzaA=='],
    ['empty salt', 'scrypt$16384$$aGFzaA=='],
    ['empty hash', 'scrypt$16384$c2FsdA==$'],
  ])('returns false rather than throwing for a malformed hash: %s', (_label, stored) => {
    expect(() => auth.verifyPassphrase('anything', stored)).not.toThrow();
    expect(auth.verifyPassphrase('anything', stored)).toBe(false);
  });
});

describe('session tokens', () => {
  const SECRET = 'test-secret-do-not-use-in-production';

  test('round-trips the claims', () => {
    const token = auth.signToken({ sub: 'prakyath', name: 'Prakyath' }, SECRET);
    const claims = auth.verifyToken(token, SECRET);
    expect(claims).toMatchObject({ sub: 'prakyath', name: 'Prakyath' });
  });

  test('rejects a token signed with a different secret', () => {
    const token = auth.signToken({ sub: 'prakyath' }, SECRET);
    expect(auth.verifyToken(token, 'a-different-secret')).toBeNull();
  });

  test('rejects a tampered payload', () => {
    const token = auth.signToken({ sub: 'shivani' }, SECRET);
    const [payload, signature] = token.split('.');
    const forged = Buffer.from(JSON.stringify({
      sub: 'attacker',
      exp: Math.floor(Date.now() / 1000) + 9999,
    })).toString('base64url');

    expect(auth.verifyToken(`${forged}.${signature}`, SECRET)).toBeNull();
    // And the original payload with a mangled signature also fails.
    expect(auth.verifyToken(`${payload}.${'x'.repeat(signature.length)}`, SECRET)).toBeNull();
  });

  test('rejects an expired token', () => {
    const issuedAt = 1_700_000_000;
    const token = auth.signToken({ sub: 'prakyath' }, SECRET, issuedAt);

    // Valid one second before expiry, dead one second after.
    expect(auth.verifyToken(token, SECRET, issuedAt + auth.TOKEN_TTL_SECONDS - 1)).not.toBeNull();
    expect(auth.verifyToken(token, SECRET, issuedAt + auth.TOKEN_TTL_SECONDS + 1)).toBeNull();
  });

  test('rejects a token with no subject', () => {
    const token = auth.signToken({ name: 'nobody' }, SECRET);
    expect(auth.verifyToken(token, SECRET)).toBeNull();
  });

  test('returns null rather than throwing for malformed input', () => {
    for (const bad of ['', null, undefined, 'no-dot', 'a.b.c', '.', 'a.', '.b', 42, {}]) {
      expect(() => auth.verifyToken(bad, SECRET)).not.toThrow();
      expect(auth.verifyToken(bad, SECRET)).toBeNull();
    }
  });

  test('refuses to verify when no secret is configured', () => {
    const token = auth.signToken({ sub: 'prakyath' }, SECRET);
    expect(auth.verifyToken(token, '')).toBeNull();
  });

  test('property: no arbitrary string verifies as a valid token', () => {
    fc.assert(
      fc.property(fc.string(), (garbage) => auth.verifyToken(garbage, SECRET) === null),
      { numRuns: 500 }
    );
  });

  test('property: a signed token always verifies for its own subject', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.string({ maxLength: 40 }),
        (sub, name) => {
          const token = auth.signToken({ sub, name }, SECRET);
          const claims = auth.verifyToken(token, SECRET);
          return claims !== null && claims.sub === sub;
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('bearerFrom', () => {
  test('reads the Authorization header regardless of casing', () => {
    expect(auth.bearerFrom({ authorization: 'Bearer abc123' })).toBe('abc123');
    expect(auth.bearerFrom({ Authorization: 'Bearer abc123' })).toBe('abc123');
    expect(auth.bearerFrom({ AUTHORIZATION: 'bearer abc123' })).toBe('abc123');
  });

  test('returns null when the header is absent or malformed', () => {
    expect(auth.bearerFrom({})).toBeNull();
    expect(auth.bearerFrom(null)).toBeNull();
    expect(auth.bearerFrom({ authorization: 'abc123' })).toBeNull();
    expect(auth.bearerFrom({ authorization: 'Basic abc123' })).toBeNull();
  });
});

describe('parseMembers', () => {
  test('parses a well-formed member list', () => {
    const members = auth.parseMembers(JSON.stringify([
      { id: 'prakyath', name: 'Prakyath', initials: 'P', accent: '#4a6fa5', passphraseHash: 'scrypt$1$a$b' },
      { id: 'shivani', name: 'Shivani', initials: 'S', accent: '#c2847a', passphraseHash: 'scrypt$1$c$d' },
    ]));

    expect(members).toHaveLength(2);
    expect(members[0].id).toBe('prakyath');
    expect(members[1].accent).toBe('#c2847a');
  });

  test('derives sensible defaults for missing fields', () => {
    const [member] = auth.parseMembers(JSON.stringify([{ id: 'shivani' }]));
    expect(member.name).toBe('shivani');
    expect(member.initials).toBe('S');
    expect(member.accent).toBeTruthy();
  });

  test('drops entries with no id, and survives malformed JSON', () => {
    expect(auth.parseMembers(JSON.stringify([{ name: 'no id' }, { id: 'ok' }]))).toHaveLength(1);
    expect(auth.parseMembers('not json')).toEqual([]);
    expect(auth.parseMembers(undefined)).toEqual([]);
    expect(auth.parseMembers(JSON.stringify({ not: 'an array' }))).toEqual([]);
  });

  test('publicMembers strips the passphrase hash', () => {
    const members = auth.parseMembers(JSON.stringify([
      { id: 'prakyath', passphraseHash: 'scrypt$16384$secret$verysecret' },
    ]));

    const published = auth.publicMembers(members);
    expect(published[0]).not.toHaveProperty('passphraseHash');
    expect(JSON.stringify(published)).not.toContain('verysecret');
  });
});
