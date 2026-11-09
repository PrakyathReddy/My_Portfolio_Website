/**
 * Archive construction and the weekly report.
 *
 * Pure functions, like entries.js and media.js. The Lambda around this does
 * the I/O; everything that could be wrong about the *shape* of a backup is
 * decided here, where a test can reach it.
 *
 * Design rule for the archive format: it must be restorable by someone who
 * does not have this application. That means plain JSON, self-describing
 * field names, media referenced by the same key the bucket uses, and a
 * version number so a future reader knows what it is looking at. No custom
 * encoding, no compression, nothing that needs code to interpret.
 */

const ARCHIVE_VERSION = 1;

/**
 * Build the nightly snapshot.
 *
 * Everything, every night - not an incremental diff. At a few thousand
 * entries this is well under a megabyte of JSON, and a full snapshot has a
 * property incremental backups do not: any single file is a complete restore.
 * There is no chain to replay and no missing link to discover later.
 */
function buildArchive({ entries, coupleId, members, now }) {
  const list = Array.isArray(entries) ? entries.slice() : [];

  // Chronological, so a human reading the file reads the journal in order.
  list.sort((a, b) => {
    if (a.date !== b.date) return String(a.date).localeCompare(String(b.date));
    return (a.createdAt || 0) - (b.createdAt || 0);
  });

  return {
    archiveVersion: ARCHIVE_VERSION,
    coupleId,
    createdAt: now,
    createdAtIso: new Date(now).toISOString(),
    // Names and accents, never passphrase hashes - a backup that leaks
    // credentials is a liability, and these are only here so a restored
    // archive can still say who wrote what.
    members: (members || []).map((m) => ({
      id: m.id,
      name: m.name,
      initials: m.initials,
      accent: m.accent,
    })),
    entries: list,
  };
}

/**
 * Integrity summary of an archive.
 *
 * This is what makes the weekly mail able to say "verified" rather than
 * "ran". It re-reads the archive's own contents and counts them, so a
 * truncated or malformed file reports differently from a healthy one.
 */
function summarizeArchive(archive) {
  const entries = (archive && Array.isArray(archive.entries)) ? archive.entries : [];

  let photos = 0;
  let words = 0;
  const authors = {};
  let earliest = null;
  let latest = null;

  for (const entry of entries) {
    if (!entry) continue;

    photos += Array.isArray(entry.media) ? entry.media.length : 0;

    const text = `${entry.title || ''} ${entry.body || ''}`.trim();
    if (text) words += text.split(/\s+/).length;

    if (entry.author) authors[entry.author] = (authors[entry.author] || 0) + 1;

    if (entry.date) {
      if (!earliest || entry.date < earliest) earliest = entry.date;
      if (!latest || entry.date > latest) latest = entry.date;
    }
  }

  return {
    archiveVersion: archive ? archive.archiveVersion : null,
    entries: entries.length,
    photos,
    words,
    authors,
    earliest,
    latest,
  };
}

/**
 * Check a parsed archive for the things that would make a restore fail.
 * Returns { ok, problems } - a list, because knowing all of them at once
 * beats discovering them one restore attempt at a time.
 */
function verifyArchive(archive) {
  const problems = [];

  if (!archive || typeof archive !== 'object') {
    return { ok: false, problems: ['archive is not a JSON object'] };
  }
  if (archive.archiveVersion !== ARCHIVE_VERSION) {
    problems.push(`unexpected archiveVersion: ${archive.archiveVersion}`);
  }
  if (!Array.isArray(archive.entries)) {
    problems.push('archive has no entries array');
    return { ok: false, problems };
  }

  const seen = new Set();
  for (const entry of archive.entries) {
    if (!entry || !entry.entryId) {
      problems.push('an entry has no entryId');
      break; // one report of this class is enough
    }
    if (seen.has(entry.entryId)) {
      problems.push(`duplicate entryId: ${entry.entryId}`);
      break;
    }
    seen.add(entry.entryId);
    if (!entry.date) {
      problems.push(`entry ${entry.entryId} has no date`);
      break;
    }
  }

  // An archive that never leaked a passphrase hash is the whole point of
  // filtering members; check it rather than trusting the filter.
  if (JSON.stringify(archive).includes('passphraseHash')) {
    problems.push('archive contains a passphrase hash');
  }

  return { ok: problems.length === 0, problems };
}

/** Entries written in the last `days` days, by entry date. */
function recentEntries(entries, now, days = 7) {
  const cutoff = new Date(now - days * 24 * 60 * 60 * 1000);
  const cutoffDate = cutoff.toISOString().slice(0, 10);
  return (entries || []).filter((entry) => entry && entry.date && entry.date >= cutoffDate);
}

function plural(count, one, many) {
  return `${count} ${count === 1 ? one : many}`;
}

function nameFor(members, id) {
  const match = (members || []).find((m) => m.id === id);
  return match ? match.name : id;
}

/**
 * The weekly mail.
 *
 * Deliberately one short message doing two jobs: a nudge to write, and the
 * liveness signal for the backup. A backup that reports nothing is
 * indistinguishable from a backup that stopped running, and the difference
 * only becomes apparent on the day it matters.
 */
function buildWeeklyReport({ archive, summary, verification, now, members }) {
  const recent = recentEntries(archive ? archive.entries : [], now, 7);
  const recentPhotos = recent.reduce(
    (total, entry) => total + (Array.isArray(entry.media) ? entry.media.length : 0), 0);

  const lines = [];

  if (recent.length === 0) {
    lines.push('Nothing written this week.');
  } else {
    const byAuthor = {};
    for (const entry of recent) {
      if (entry.author) byAuthor[entry.author] = (byAuthor[entry.author] || 0) + 1;
    }
    const breakdown = Object.keys(byAuthor)
      .map((id) => `${nameFor(members, id)} ${byAuthor[id]}`)
      .join(', ');

    lines.push(
      `This week: ${plural(recent.length, 'entry', 'entries')}` +
      (recentPhotos ? `, ${plural(recentPhotos, 'photo', 'photos')}` : '') +
      (breakdown ? ` (${breakdown})` : '') + '.'
    );
  }

  lines.push('');

  if (verification && verification.ok) {
    lines.push(
      `Backup verified: ${plural(summary.entries, 'entry', 'entries')}, ` +
      `${plural(summary.photos, 'photo', 'photos')}, ` +
      `${plural(summary.words, 'word', 'words')}.`
    );
    if (summary.earliest && summary.latest) {
      lines.push(`Covering ${summary.earliest} to ${summary.latest}.`);
    }
  } else {
    // Loud, and first thing they read after the week's news.
    lines.unshift('BACKUP PROBLEM - please look.');
    lines.push('Backup FAILED verification:');
    for (const problem of (verification ? verification.problems : ['no archive found'])) {
      lines.push(`  - ${problem}`);
    }
  }

  const subject = verification && verification.ok
    ? (recent.length
        ? `Mana Muchatlu - ${plural(recent.length, 'entry', 'entries')} this week`
        : 'Mana Muchatlu - a quiet week')
    : 'Mana Muchatlu - BACKUP PROBLEM';

  return { subject, body: lines.join('\n') };
}

/** Object key for a night's snapshot. Date-prefixed so it sorts. */
function archiveKey(dateIso) {
  return `archives/${dateIso}/entries.json`;
}

/** The pointer a restore reads first, always at the same place. */
function latestKey() {
  return 'archives/latest.json';
}

module.exports = {
  ARCHIVE_VERSION,
  buildArchive,
  summarizeArchive,
  verifyArchive,
  recentEntries,
  buildWeeklyReport,
  archiveKey,
  latestKey,
};
