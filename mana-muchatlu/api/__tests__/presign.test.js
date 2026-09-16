/**
 * Tests for SigV4 presigning.
 *
 * Signing is all-or-nothing: one wrong character anywhere in the canonical
 * request yields a signature that S3 rejects with a message that does not say
 * what was wrong. So these tests pin the structure precisely, and pin
 * determinism so that a refactor cannot quietly change the output.
 */

const fc = require('fast-check');
const { presignS3, encodeRfc3986, encodeKey, amzDate } = require('../lib/presign');

const CREDS = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
};
const WHEN = new Date('2026-09-15T06:30:00.000Z');

const BASE = {
  bucket: 'mana-muchatlu-media-123',
  key: 'media/mana/2026-09/abc123.jpg',
  region: 'us-east-1',
  credentials: CREDS,
  now: WHEN,
};

describe('amzDate', () => {
  test('formats as ISO8601 basic', () => {
    expect(amzDate(WHEN)).toBe('20260915T063000Z');
  });
});

describe('encoding', () => {
  test('percent-encodes the characters encodeURIComponent leaves alone', () => {
    // AWS requires these encoded; a mismatch invalidates the signature.
    expect(encodeRfc3986("!'()*")).toBe('%21%27%28%29%2A');
  });

  test('encodes a space as %20, never +', () => {
    expect(encodeRfc3986('a b')).toBe('a%20b');
  });

  test('keeps slashes as separators in a key but encodes each segment', () => {
    expect(encodeKey('media/mana/2026-09/a b.jpg')).toBe('media/mana/2026-09/a%20b.jpg');
    expect(encodeKey('media/mana/2026-09/x.jpg')).toBe('media/mana/2026-09/x.jpg');
  });
});

describe('AWS reference vector', () => {
  // The example from AWS's own SigV4 query-parameter documentation. Everything
  // else in this file checks the implementation against itself; this checks it
  // against AWS. If a refactor breaks the canonical request in any way, this
  // is the test that notices - S3 would otherwise just say "signature does not
  // match" without saying why.
  test('reproduces the documented signature exactly', () => {
    const url = presignS3({
      method: 'GET',
      bucket: 'examplebucket',
      host: 'examplebucket.s3.amazonaws.com', // legacy host used by the example
      key: 'test.txt',
      region: 'us-east-1',
      expiresIn: 86400,
      now: new Date('2013-05-24T00:00:00.000Z'),
      credentials: {
        accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
        secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      },
    });

    expect(new URL(url).searchParams.get('X-Amz-Signature'))
      .toBe('aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
  });
});

describe('presignS3', () => {
  test('produces a URL with every required SigV4 parameter', () => {
    const url = new URL(presignS3({ ...BASE, method: 'PUT', expiresIn: 900 }));

    expect(url.protocol).toBe('https:');
    expect(url.host).toBe('mana-muchatlu-media-123.s3.us-east-1.amazonaws.com');
    expect(url.pathname).toBe('/media/mana/2026-09/abc123.jpg');

    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256');
    expect(url.searchParams.get('X-Amz-Credential'))
      .toBe(`${CREDS.accessKeyId}/20260915/us-east-1/s3/aws4_request`);
    expect(url.searchParams.get('X-Amz-Date')).toBe('20260915T063000Z');
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900');
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('host');
    expect(url.searchParams.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
  });

  test('includes the session token when credentials are temporary', () => {
    const withToken = presignS3({
      ...BASE,
      credentials: { ...CREDS, sessionToken: 'FwoGZXIvYXdzEXAMPLETOKEN' },
    });
    expect(new URL(withToken).searchParams.get('X-Amz-Security-Token'))
      .toBe('FwoGZXIvYXdzEXAMPLETOKEN');
  });

  test('omits the session token for long-lived credentials', () => {
    expect(new URL(presignS3(BASE)).searchParams.has('X-Amz-Security-Token')).toBe(false);
  });

  test('is deterministic for identical inputs', () => {
    expect(presignS3(BASE)).toBe(presignS3(BASE));
  });

  test('signature changes with method, key, time, region and expiry', () => {
    const base = presignS3(BASE);
    const sig = (url) => new URL(url).searchParams.get('X-Amz-Signature');

    expect(sig(presignS3({ ...BASE, method: 'PUT' }))).not.toBe(sig(base));
    expect(sig(presignS3({ ...BASE, key: 'media/mana/2026-09/other.jpg' }))).not.toBe(sig(base));
    expect(sig(presignS3({ ...BASE, now: new Date('2026-09-15T06:30:01.000Z') }))).not.toBe(sig(base));
    expect(sig(presignS3({ ...BASE, region: 'eu-west-1' }))).not.toBe(sig(base));
    expect(sig(presignS3({ ...BASE, expiresIn: 901 }))).not.toBe(sig(base));
  });

  test('a different secret key yields a different signature', () => {
    const other = presignS3({
      ...BASE,
      credentials: { ...CREDS, secretAccessKey: 'a-completely-different-secret-key-value' },
    });
    expect(new URL(other).searchParams.get('X-Amz-Signature'))
      .not.toBe(new URL(presignS3(BASE)).searchParams.get('X-Amz-Signature'));
  });

  test('query parameters are sorted, as the canonical request requires', () => {
    const query = presignS3({
      ...BASE,
      credentials: { ...CREDS, sessionToken: 'token' },
    }).split('?')[1];

    // Signature is appended last and is not part of the canonical query.
    const names = query.split('&').map((pair) => pair.split('=')[0]).slice(0, -1);
    expect(names).toEqual([...names].sort());
  });

  test('rejects missing or nonsensical arguments', () => {
    expect(() => presignS3({ ...BASE, bucket: '' })).toThrow(/bucket/);
    expect(() => presignS3({ ...BASE, key: '' })).toThrow(/key/);
    expect(() => presignS3({ ...BASE, region: '' })).toThrow(/region/);
    expect(() => presignS3({ ...BASE, credentials: null })).toThrow(/credentials/);
    expect(() => presignS3({ ...BASE, credentials: { accessKeyId: 'x' } })).toThrow(/credentials/);
    expect(() => presignS3({ ...BASE, expiresIn: 0 })).toThrow(/expiresIn/);
    expect(() => presignS3({ ...BASE, expiresIn: 604801 })).toThrow(/expiresIn/);
    expect(() => presignS3({ ...BASE, expiresIn: 1.5 })).toThrow(/expiresIn/);
  });

  test('never leaks the secret key into the URL', () => {
    const url = presignS3({ ...BASE, credentials: { ...CREDS, sessionToken: 'tok' } });
    expect(url).not.toContain(CREDS.secretAccessKey);
    // The access key id is public and legitimately appears in X-Amz-Credential.
    expect(url).toContain(CREDS.accessKeyId);
  });

  test('property: any valid key round-trips into a parseable URL path', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z0-9_-]{1,40}$/),
        (id) => {
          const key = `media/mana/2026-09/${id}.jpg`;
          const url = new URL(presignS3({ ...BASE, key }));
          return decodeURIComponent(url.pathname) === `/${key}`;
        }
      ),
      { numRuns: 200 }
    );
  });
});
