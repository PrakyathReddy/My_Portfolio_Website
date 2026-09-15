/**
 * Tests for archive construction, verification and the weekly report.
 *
 * A backup is the one piece of code whose bugs stay invisible until the day
 * you need it. So these tests care most about two things: that the archive
 * never leaks a credential, and that a damaged archive is reported as damaged
 * rather than quietly passing.
 */

const fc = require('fast-check');
const archiveLib = require('../lib/archive');

const MEMBERS = [
  { id: 'bangarammm', name: 'bangarammm', initials: 'Ba', accent: '#4a6fa5', passphraseHash: 'scrypt$16384$salt$verysecret' },
  { id: 'bujjuluu', name: 'bujjuluu', initials: 'Bu', accent: '#c2847a', passphraseHash: 'scrypt$16384$salt$alsosecret' },
];

const NOW = Date.parse('2026-09-15T06:00:00.000Z');

function entry(overrides) {
  return Object.assign({
    entryId: 'e' + Math.random().toString(36).slice(2, 8),
    date: '2026-09-14',
    title: 'A day',
    body: 'Something happened.',
    mood: '',
    media: [],
    author: 'bangarammm',
    createdAt: NOW,
    updatedAt: NOW,
  }, overrides || {});
}

describe('buildArchive', () => {
  test('captures entries, members and a timestamp', () => {
    const archive = archiveLib.buildArchive({
      entries: [entry({ entryId: 'a' })],
      coupleId: 'mana',
      members: MEMBERS,
      now: NOW,
    });

    expect(archive.archiveVersion).toBe(archiveLib.ARCHIVE_VERSION);
    expect(archive.coupleId).toBe('mana');
    expect(archive.entries).toHaveLength(1);
    expect(archive.createdAtIso).toBe('2026-09-15T06:00:00.000Z');
    expect(archive.members.map((m) => m.id)).toEqual(['bangarammm', 'bujjuluu']);
  });

  test('NEVER includes passphrase hashes', () => {
    // The single most important property of this file. A backup that leaks
    // credentials is worse than no backup, because it gets copied around.
    const archive = archiveLib.buildArchive({
      entries: [entry()], coupleId: 'mana', members: MEMBERS, now: NOW,
    });

    const serialised = JSON.stringify(archive);
    expect(serialised).not.toContain('passphraseHash');
    expect(serialised).not.toContain('verysecret');
    expect(serialised).not.toContain('alsosecret');
    expect(serialised).not.toContain('scrypt');
  });

  test('orders entries chronologically', () => {
    const archive = archiveLib.buildArchive({
      entries: [
        entry({ entryId: 'c', date: '2026-09-20' }),
        entry({ entryId: 'a', date: '2026-09-01' }),
        entry({ entryId: 'b', date: '2026-09-14' }),
      ],
      coupleId: 'mana', members: MEMBERS, now: NOW,
    });

    expect(archive.entries.map((e) => e.entryId)).toEqual(['a', 'b', 'c']);
  });

  test('breaks same-day ties by creation time', () => {
    const archive = archiveLib.buildArchive({
      entries: [
        entry({ entryId: 'second', date: '2026-09-14', createdAt: 2000 }),
        entry({ entryId: 'first', date: '2026-09-14', createdAt: 1000 }),
      ],
      coupleId: 'mana', members: MEMBERS, now: NOW,
    });

    expect(archive.entries.map((e) => e.entryId)).toEqual(['first', 'second']);
  });

  test('does not mutate the caller\'s array', () => {
    const original = [entry({ entryId: 'b', date: '2026-09-20' }), entry({ entryId: 'a', date: '2026-09-01' })];
    const before = original.map((e) => e.entryId);
    archiveLib.buildArchive({ entries: original, coupleId: 'mana', members: MEMBERS, now: NOW });
    expect(original.map((e) => e.entryId)).toEqual(before);
  });

  test('survives an empty or missing journal', () => {
    for (const empty of [[], null, undefined]) {
      const archive = archiveLib.buildArchive({
        entries: empty, coupleId: 'mana', members: MEMBERS, now: NOW,
      });
      expect(archive.entries).toEqual([]);
    }
  });
});

describe('summarizeArchive', () => {
  test('counts entries, photos, words and authors', () => {
    const archive = archiveLib.buildArchive({
      entries: [
        entry({ date: '2026-09-01', author: 'bangarammm', title: 'One two', body: 'three four five', media: [{ key: 'a' }] }),
        entry({ date: '2026-09-20', author: 'bujjuluu', title: '', body: 'six', media: [{ key: 'b' }, { key: 'c' }] }),
      ],
      coupleId: 'mana', members: MEMBERS, now: NOW,
    });

    const summary = archiveLib.summarizeArchive(archive);
    expect(summary.entries).toBe(2);
    expect(summary.photos).toBe(3);
    expect(summary.words).toBe(6);
    expect(summary.authors).toEqual({ bangarammm: 1, bujjuluu: 1 });
    expect(summary.earliest).toBe('2026-09-01');
    expect(summary.latest).toBe('2026-09-20');
  });

  test('handles an empty archive without throwing', () => {
    const summary = archiveLib.summarizeArchive({ archiveVersion: 1, entries: [] });
    expect(summary.entries).toBe(0);
    expect(summary.photos).toBe(0);
    expect(summary.earliest).toBeNull();
  });

  test('never throws on junk', () => {
    for (const junk of [null, undefined, {}, { entries: 'not an array' }, { entries: [null, {}] }]) {
      expect(() => archiveLib.summarizeArchive(junk)).not.toThrow();
    }
  });
});

describe('verifyArchive', () => {
  const good = () => archiveLib.buildArchive({
    entries: [entry({ entryId: 'a' }), entry({ entryId: 'b' })],
    coupleId: 'mana', members: MEMBERS, now: NOW,
  });

  test('passes a well-formed archive', () => {
    expect(archiveLib.verifyArchive(good())).toEqual({ ok: true, problems: [] });
  });

  test('catches a wrong version', () => {
    const archive = good();
    archive.archiveVersion = 99;
    const result = archiveLib.verifyArchive(archive);
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/archiveVersion/);
  });

  test('catches a missing entries array', () => {
    expect(archiveLib.verifyArchive({ archiveVersion: 1 }).ok).toBe(false);
  });

  test('catches duplicate entry ids', () => {
    const archive = good();
    archive.entries[1].entryId = archive.entries[0].entryId;
    const result = archiveLib.verifyArchive(archive);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/duplicate/);
  });

  test('catches an entry with no id or no date', () => {
    const noId = good();
    delete noId.entries[0].entryId;
    expect(archiveLib.verifyArchive(noId).ok).toBe(false);

    const noDate = good();
    delete noDate.entries[0].date;
    expect(archiveLib.verifyArchive(noDate).ok).toBe(false);
  });

  test('catches a leaked passphrase hash', () => {
    const archive = good();
    archive.members[0].passphraseHash = 'scrypt$16384$x$y';
    const result = archiveLib.verifyArchive(archive);
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/passphrase/);
  });

  test('rejects anything that is not an object', () => {
    for (const junk of [null, undefined, 'a string', 42, []]) {
      const result = archiveLib.verifyArchive(junk);
      // An array has no entries array of its own, so it fails either way.
      expect(result.ok).toBe(false);
    }
  });
});

describe('recentEntries', () => {
  test('keeps only the last seven days', () => {
    const entries = [
      entry({ date: '2026-09-15' }), // today
      entry({ date: '2026-09-09' }), // within 7 days
      entry({ date: '2026-09-01' }), // older
    ];
    const recent = archiveLib.recentEntries(entries, NOW, 7);
    expect(recent.map((e) => e.date)).toEqual(['2026-09-15', '2026-09-09']);
  });

  test('handles an empty list', () => {
    expect(archiveLib.recentEntries([], NOW)).toEqual([]);
    expect(archiveLib.recentEntries(null, NOW)).toEqual([]);
  });
});

describe('buildWeeklyReport', () => {
  function report(entries, verification) {
    const archive = archiveLib.buildArchive({
      entries, coupleId: 'mana', members: MEMBERS, now: NOW,
    });
    return archiveLib.buildWeeklyReport({
      archive,
      summary: archiveLib.summarizeArchive(archive),
      verification: verification || archiveLib.verifyArchive(archive),
      now: NOW,
      members: MEMBERS,
    });
  }

  test('reports a week with entries, named by author', () => {
    const result = report([
      entry({ date: '2026-09-14', author: 'bangarammm', media: [{ key: 'a' }] }),
      entry({ date: '2026-09-15', author: 'bujjuluu' }),
    ]);

    expect(result.subject).toMatch(/2 entries this week/);
    expect(result.body).toMatch(/This week: 2 entries, 1 photo/);
    expect(result.body).toMatch(/bangarammm 1/);
    expect(result.body).toMatch(/bujjuluu 1/);
    expect(result.body).toMatch(/Backup verified/);
  });

  test('says so plainly when nothing was written', () => {
    const result = report([entry({ date: '2026-08-01' })]);
    expect(result.subject).toMatch(/a quiet week/);
    expect(result.body).toMatch(/Nothing written this week/);
    // The backup line still appears - that is the liveness signal.
    expect(result.body).toMatch(/Backup verified/);
  });

  test('uses singular wording for one entry', () => {
    const result = report([entry({ date: '2026-09-15' })]);
    expect(result.body).toMatch(/This week: 1 entry\b/);
    expect(result.body).not.toMatch(/1 entries/);
  });

  test('leads with the problem when verification fails', () => {
    const result = report(
      [entry({ date: '2026-09-15' })],
      { ok: false, problems: ['archive has no entries array'] }
    );

    expect(result.subject).toMatch(/BACKUP PROBLEM/);
    // First line, before the week's news - it is the thing that needs acting on.
    expect(result.body.split('\n')[0]).toMatch(/BACKUP PROBLEM/);
    expect(result.body).toMatch(/archive has no entries array/);
  });

  test('a quiet week and a broken backup still reads as broken', () => {
    const result = report([], { ok: false, problems: ['no archive found'] });
    expect(result.subject).toMatch(/BACKUP PROBLEM/);
    expect(result.body).toMatch(/no archive found/);
  });

  test('never throws, whatever the journal looks like', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({
          entryId: fc.string({ minLength: 1, maxLength: 10 }),
          date: fc.constantFrom('2026-09-15', '2026-01-01', '2026-09-09'),
          title: fc.string({ maxLength: 20 }),
          body: fc.string({ maxLength: 40 }),
          author: fc.constantFrom('bangarammm', 'bujjuluu'),
          media: fc.array(fc.record({ key: fc.string({ minLength: 1, maxLength: 8 }) }), { maxLength: 3 }),
          createdAt: fc.integer({ min: 0, max: NOW }),
        }), { maxLength: 20 }),
        (entries) => {
          const result = report(entries);
          return typeof result.subject === 'string' && typeof result.body === 'string';
        }
      ),
      { numRuns: 200 }
    );
  });
});

describe('keys', () => {
  test('archive keys sort chronologically', () => {
    expect(archiveLib.archiveKey('2026-09-15')).toBe('archives/2026-09-15/entries.json');
    expect(archiveLib.archiveKey('2026-01-01') < archiveLib.archiveKey('2026-09-15')).toBe(true);
  });

  test('latest pointer is at a fixed, guessable place', () => {
    // A restore should not have to list the bucket to find where to start.
    expect(archiveLib.latestKey()).toBe('archives/latest.json');
  });
});
