/**
 * Tests for media key construction and validation.
 *
 * Media keys come back from the browser when an entry is saved, so they are
 * untrusted input that gets turned into an S3 path. The traversal cases below
 * are the ones that matter.
 */

const fc = require('fast-check');
const media = require('../lib/media');

describe('content types', () => {
  test('accepts the image types we allow', () => {
    for (const type of Object.keys(media.CONTENT_TYPES)) {
      expect(media.isAllowedContentType(type)).toBe(true);
    }
  });

  test('is case-insensitive', () => {
    expect(media.isAllowedContentType('IMAGE/JPEG')).toBe(true);
  });

  test('rejects anything not on the allow-list', () => {
    for (const type of ['text/html', 'application/javascript', 'image/svg+xml', 'video/mp4', '', null]) {
      expect(media.isAllowedContentType(type)).toBe(false);
    }
  });

  test('image/svg+xml stays out - SVG is script-capable', () => {
    expect(media.isAllowedContentType('image/svg+xml')).toBe(false);
  });

  test('maps types to sensible extensions', () => {
    expect(media.extensionFor('image/jpeg')).toBe('jpg');
    expect(media.extensionFor('image/png')).toBe('png');
    expect(media.extensionFor('image/heic')).toBe('heic');
    expect(media.extensionFor('nonsense')).toBe('bin');
  });
});

describe('buildMediaKey', () => {
  test('lays the key out as media/<couple>/<month>/<id>.<ext>', () => {
    expect(media.buildMediaKey({
      coupleId: 'mana', month: '2026-09', id: 'abc123', contentType: 'image/jpeg',
    })).toBe('media/mana/2026-09/abc123.jpg');
  });

  test('keys it builds always validate', () => {
    const key = media.buildMediaKey({
      coupleId: 'mana', month: '2026-09', id: 'abc-123_XYZ', contentType: 'image/png',
    });
    expect(media.isValidMediaKey(key, 'mana')).toBe(true);
  });
});

describe('isValidMediaKey', () => {
  test('accepts a well-formed key', () => {
    expect(media.isValidMediaKey('media/mana/2026-09/abc123.jpg', 'mana')).toBe(true);
  });

  test('rejects path traversal', () => {
    for (const bad of [
      'media/mana/2026-09/../../../etc/passwd',
      'media/mana/../other/2026-09/a.jpg',
      '../media/mana/2026-09/a.jpg',
      '/media/mana/2026-09/a.jpg',
      'media/mana//2026-09/a.jpg',
    ]) {
      expect(media.isValidMediaKey(bad, 'mana')).toBe(false);
    }
  });

  test('rejects another couple\'s prefix', () => {
    expect(media.isValidMediaKey('media/someone-else/2026-09/a.jpg', 'mana')).toBe(false);
  });

  test('rejects a malformed month or extension', () => {
    expect(media.isValidMediaKey('media/mana/202609/a.jpg', 'mana')).toBe(false);
    expect(media.isValidMediaKey('media/mana/2026-09/a', 'mana')).toBe(false);
    expect(media.isValidMediaKey('media/mana/2026-09/a.JPG', 'mana')).toBe(false);
  });

  test('rejects an over-long key and junk input', () => {
    expect(media.isValidMediaKey('media/mana/2026-09/' + 'x'.repeat(400) + '.jpg', 'mana')).toBe(false);
    for (const bad of ['', null, undefined, 42, {}]) {
      expect(() => media.isValidMediaKey(bad, 'mana')).not.toThrow();
      expect(media.isValidMediaKey(bad, 'mana')).toBe(false);
    }
  });

  test('a regex-special coupleId cannot widen the pattern', () => {
    // If coupleId were interpolated unescaped, "." would match any character.
    expect(media.isValidMediaKey('media/xxxx/2026-09/a.jpg', 'x.xx')).toBe(false);
    expect(media.isValidMediaKey('media/x.xx/2026-09/a.jpg', 'x.xx')).toBe(true);
  });

  test('property: no arbitrary string validates', () => {
    fc.assert(
      fc.property(fc.string(), (junk) => media.isValidMediaKey(junk, 'mana') === false),
      { numRuns: 500 }
    );
  });
});

describe('validateMedia', () => {
  const key = (n) => `media/mana/2026-09/photo${n}.jpg`;

  test('treats absent media as an empty list', () => {
    for (const empty of [undefined, null, '']) {
      const result = media.validateMedia(empty, 'mana');
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([]);
    }
  });

  test('accepts plain keys and objects alike', () => {
    const fromStrings = media.validateMedia([key(1), key(2)], 'mana');
    expect(fromStrings.ok).toBe(true);
    expect(fromStrings.value.map((m) => m.key)).toEqual([key(1), key(2)]);

    const fromObjects = media.validateMedia(
      [{ key: key(1), contentType: 'image/jpeg' }], 'mana');
    expect(fromObjects.value[0]).toEqual({ key: key(1), contentType: 'image/jpeg' });
  });

  test('drops a disallowed contentType but keeps the key', () => {
    const result = media.validateMedia([{ key: key(1), contentType: 'text/html' }], 'mana');
    expect(result.ok).toBe(true);
    expect(result.value[0].contentType).toBe('');
  });

  test('de-duplicates repeated keys', () => {
    const result = media.validateMedia([key(1), key(1), key(2)], 'mana');
    expect(result.value).toHaveLength(2);
  });

  test('rejects a foreign or malformed key outright', () => {
    expect(media.validateMedia(['media/other/2026-09/a.jpg'], 'mana').ok).toBe(false);
    expect(media.validateMedia(['../../etc/passwd'], 'mana').ok).toBe(false);
  });

  test('enforces the per-entry cap', () => {
    const many = Array.from({ length: media.MAX_PER_ENTRY + 1 }, (_, i) => key(i));
    const result = media.validateMedia(many, 'mana');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/at most/);

    const exactly = Array.from({ length: media.MAX_PER_ENTRY }, (_, i) => key(i));
    expect(media.validateMedia(exactly, 'mana').ok).toBe(true);
  });

  test('rejects a non-list', () => {
    expect(media.validateMedia('not a list', 'mana').ok).toBe(false);
    expect(media.validateMedia({ key: key(1) }, 'mana').ok).toBe(false);
  });

  test('never throws', () => {
    for (const bad of [42, [null], [{}], [[]], [{ key: 42 }]]) {
      expect(() => media.validateMedia(bad, 'mana')).not.toThrow();
    }
  });
});

describe('validatePresignRequest', () => {
  test('accepts an allowed image type', () => {
    const result = media.validatePresignRequest({ contentType: 'image/jpeg', size: 2_000_000 });
    expect(result.ok).toBe(true);
    expect(result.value.contentType).toBe('image/jpeg');
  });

  test('rejects a disallowed type', () => {
    expect(media.validatePresignRequest({ contentType: 'application/pdf' }).ok).toBe(false);
    expect(media.validatePresignRequest({}).ok).toBe(false);
  });

  test('rejects an oversized upload before it starts', () => {
    const result = media.validatePresignRequest({
      contentType: 'image/jpeg', size: media.MAX_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/under/);
  });

  test('tolerates a missing or unparseable size', () => {
    expect(media.validatePresignRequest({ contentType: 'image/png' }).ok).toBe(true);
    expect(media.validatePresignRequest({ contentType: 'image/png', size: 'big' }).ok).toBe(true);
  });

  test('never throws', () => {
    for (const bad of [null, undefined, 'x', 42, []]) {
      expect(() => media.validatePresignRequest(bad)).not.toThrow();
    }
  });
});
