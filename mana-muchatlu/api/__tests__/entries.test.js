/**
 * Tests for entry validation, key construction and month summarising.
 */

const fc = require('fast-check');
const entries = require('../lib/entries');

describe('normalizeDate', () => {
  test('accepts real dates', () => {
    expect(entries.normalizeDate('2026-09-15')).toBe('2026-09-15');
    expect(entries.normalizeDate('2024-02-29')).toBe('2024-02-29'); // leap year
    expect(entries.normalizeDate('  2026-01-01  ')).toBe('2026-01-01'); // trimmed
  });

  test('rejects dates that look valid but are not', () => {
    expect(entries.normalizeDate('2026-02-30')).toBeNull();
    expect(entries.normalizeDate('2026-02-29')).toBeNull(); // 2026 is not a leap year
    expect(entries.normalizeDate('2026-13-01')).toBeNull();
    expect(entries.normalizeDate('2026-00-10')).toBeNull();
    expect(entries.normalizeDate('2026-04-31')).toBeNull();
  });

  test('rejects malformed input without throwing', () => {
    for (const bad of ['', null, undefined, '2026-9-15', '15-09-2026', 'yesterday', 42, {}]) {
      expect(() => entries.normalizeDate(bad)).not.toThrow();
      expect(entries.normalizeDate(bad)).toBeNull();
    }
  });

  test('property: every date it accepts round-trips through Date unchanged', () => {
    fc.assert(
      fc.property(fc.date({ min: new Date('1970-01-01'), max: new Date('2100-01-01'), noInvalidDate: true }), (d) => {
        const iso = d.toISOString().slice(0, 10);
        return entries.normalizeDate(iso) === iso;
      }),
      { numRuns: 300 }
    );
  });
});

describe('normalizeMonth', () => {
  test('accepts YYYY-MM and rejects anything else', () => {
    expect(entries.normalizeMonth('2026-09')).toBe('2026-09');
    expect(entries.normalizeMonth('2026-13')).toBeNull();
    expect(entries.normalizeMonth('2026-00')).toBeNull();
    expect(entries.normalizeMonth('2026-09-15')).toBeNull();
    expect(entries.normalizeMonth('')).toBeNull();
  });
});

describe('key construction', () => {
  test('builds the documented key shape', () => {
    expect(entries.partitionKey('mana')).toBe('COUPLE#mana');
    expect(entries.entrySortKey('2026-09-15', 'abc')).toBe('ENTRY#2026-09-15#abc');
    expect(entries.monthPrefix('2026-09')).toBe('ENTRY#2026-09');
  });

  test('a month prefix matches exactly that month', () => {
    const september = entries.monthPrefix('2026-09');
    expect(entries.entrySortKey('2026-09-01', 'x').startsWith(september)).toBe(true);
    expect(entries.entrySortKey('2026-09-30', 'x').startsWith(september)).toBe(true);
    expect(entries.entrySortKey('2026-10-01', 'x').startsWith(september)).toBe(false);
    expect(entries.entrySortKey('2025-09-15', 'x').startsWith(september)).toBe(false);
  });

  test('property: sort keys order chronologically as plain strings', () => {
    // This is the property the whole single-table design rests on: if string
    // ordering ever diverged from date ordering, the calendar query breaks.
    fc.assert(
      fc.property(
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        (a, b) => {
          const dateA = a.toISOString().slice(0, 10);
          const dateB = b.toISOString().slice(0, 10);
          const keyA = entries.entrySortKey(dateA, 'same-id');
          const keyB = entries.entrySortKey(dateB, 'same-id');
          return Math.sign(keyA.localeCompare(keyB)) === Math.sign(dateA.localeCompare(dateB));
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('validateEntry', () => {
  test('accepts a normal entry', () => {
    const result = entries.validateEntry({
      title: 'Beach day',
      body: 'We drove to the coast and ate too much.',
      date: '2026-09-15',
      mood: 'happy',
    });

    expect(result.ok).toBe(true);
    expect(result.value.title).toBe('Beach day');
    expect(result.value.mood).toBe('happy');
  });

  test('accepts a body with no title, and a title with no body', () => {
    expect(entries.validateEntry({ body: 'just a thought', date: '2026-09-15' }).ok).toBe(true);
    expect(entries.validateEntry({ title: 'just a title', date: '2026-09-15' }).ok).toBe(true);
  });

  test('rejects a completely empty entry', () => {
    const result = entries.validateEntry({ date: '2026-09-15' });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/at least a title or some text/);
  });

  test('treats whitespace-only content as empty', () => {
    const result = entries.validateEntry({ title: '   ', body: '\n\t ', date: '2026-09-15' });
    expect(result.ok).toBe(false);
  });

  test('requires a valid date', () => {
    expect(entries.validateEntry({ body: 'hi' }).ok).toBe(false);
    expect(entries.validateEntry({ body: 'hi', date: '2026-02-30' }).ok).toBe(false);
    expect(entries.validateEntry({ body: 'hi' }, { requireDate: false }).ok).toBe(true);
  });

  test('enforces length limits', () => {
    const longTitle = entries.validateEntry({
      title: 'x'.repeat(entries.MAX_TITLE + 1),
      date: '2026-09-15',
    });
    expect(longTitle.ok).toBe(false);
    expect(longTitle.errors[0]).toMatch(/title must be/);

    const longBody = entries.validateEntry({
      body: 'x'.repeat(entries.MAX_BODY + 1),
      date: '2026-09-15',
    });
    expect(longBody.ok).toBe(false);
  });

  test('accepts content exactly at the limit', () => {
    expect(entries.validateEntry({
      title: 'x'.repeat(entries.MAX_TITLE),
      date: '2026-09-15',
    }).ok).toBe(true);
  });

  test('rejects an unknown mood but allows none at all', () => {
    expect(entries.validateEntry({ body: 'hi', date: '2026-09-15', mood: 'hangry' }).ok).toBe(false);
    expect(entries.validateEntry({ body: 'hi', date: '2026-09-15', mood: '' }).ok).toBe(true);
    expect(entries.validateEntry({ body: 'hi', date: '2026-09-15' }).value.mood).toBe('');
  });

  test('never throws, whatever it is handed', () => {
    for (const bad of [null, undefined, 'a string', 42, [], { title: {}, body: [] }]) {
      expect(() => entries.validateEntry(bad)).not.toThrow();
    }
  });

  test('property: an accepted entry always carries a normalized date', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        fc.date({ min: new Date('2000-01-01'), max: new Date('2099-12-31'), noInvalidDate: true }),
        (body, d) => {
          const iso = d.toISOString().slice(0, 10);
          const result = entries.validateEntry({ body, date: iso });
          // Empty-after-trim bodies are legitimately rejected; ignore those.
          if (!result.ok) return body.trim().length === 0;
          return result.value.date === iso;
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe('toPublicEntry', () => {
  test('drops the internal partition and sort keys', () => {
    const item = entries.buildEntryItem({
      coupleId: 'mana',
      entryId: 'e1',
      author: 'shivani',
      value: { title: 'T', body: 'B', date: '2026-09-15', mood: 'calm' },
      now: 1_700_000_000_000,
    });

    const published = entries.toPublicEntry(item);
    expect(published).not.toHaveProperty('pk');
    expect(published).not.toHaveProperty('sk');
    expect(published.author).toBe('shivani');
    expect(published.entryId).toBe('e1');
  });

  test('returns null for a missing item', () => {
    expect(entries.toPublicEntry(null)).toBeNull();
    expect(entries.toPublicEntry(undefined)).toBeNull();
  });
});

describe('summarizeMonth', () => {
  test('counts entries per day and lists distinct authors', () => {
    const summary = entries.summarizeMonth([
      { date: '2026-09-14', author: 'prakyath' },
      { date: '2026-09-14', author: 'shivani' },
      { date: '2026-09-14', author: 'shivani' },
      { date: '2026-09-20', author: 'prakyath' },
    ]);

    expect(summary['2026-09-14']).toEqual({ total: 3, authors: ['prakyath', 'shivani'] });
    expect(summary['2026-09-20']).toEqual({ total: 1, authors: ['prakyath'] });
    expect(summary['2026-09-15']).toBeUndefined();
  });

  test('handles an empty or junk month without throwing', () => {
    expect(entries.summarizeMonth([])).toEqual({});
    expect(entries.summarizeMonth(null)).toEqual({});
    expect(entries.summarizeMonth([null, {}, { author: 'x' }])).toEqual({});
  });
});
