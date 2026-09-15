/**
 * Entry shaping, validation and DynamoDB key construction.
 *
 * All pure functions - no AWS SDK, no I/O. That is the whole point: the parts
 * most likely to be wrong are the parts a unit test can reach.
 *
 * Key design (single table):
 *   PK = COUPLE#<coupleId>
 *   SK = ENTRY#<YYYY-MM-DD>#<entryId>
 *
 * A lexicographic SK means "give me September" is one begins_with query on
 * "ENTRY#2026-09", and the calendar month view costs exactly one read. No GSI,
 * no scan, no second access pattern to maintain.
 */

const MAX_TITLE = 200;
const MAX_BODY = 20000;
const MOODS = ['happy', 'calm', 'grateful', 'silly', 'sad', 'tired', 'excited', 'missing-you'];

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_RE = /^(\d{4})-(\d{2})$/;

/**
 * Validate a YYYY-MM-DD string as a real calendar date.
 * Rejects 2026-02-30 and friends, which a regex alone would happily accept.
 */
function normalizeDate(input) {
  const match = DATE_RE.exec(String(input || '').trim());
  if (!match) return null;

  const [, y, m, d] = match;
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Round-trip through Date: if the components survive, the date is real.
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() !== month - 1 ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }

  return `${y}-${m}-${d}`;
}

function normalizeMonth(input) {
  const match = MONTH_RE.exec(String(input || '').trim());
  if (!match) return null;
  const month = Number(match[2]);
  if (month < 1 || month > 12) return null;
  return `${match[1]}-${match[2]}`;
}

function partitionKey(coupleId) {
  return `COUPLE#${coupleId}`;
}

function entrySortKey(date, entryId) {
  return `ENTRY#${date}#${entryId}`;
}

/** SK prefix that selects exactly one month's entries. */
function monthPrefix(month) {
  return `ENTRY#${month}`;
}

/**
 * Validate and normalize an incoming entry body.
 * Returns { ok, errors, value } - never throws, so the handler stays flat.
 */
function validateEntry(input, { requireDate = true } = {}) {
  const errors = [];
  const src = input && typeof input === 'object' ? input : {};

  const title = typeof src.title === 'string' ? src.title.trim() : '';
  if (title.length > MAX_TITLE) {
    errors.push(`title must be ${MAX_TITLE} characters or fewer`);
  }

  const body = typeof src.body === 'string' ? src.body.trim() : '';
  if (!body && !title) {
    errors.push('an entry needs at least a title or some text');
  }
  if (body.length > MAX_BODY) {
    errors.push(`body must be ${MAX_BODY} characters or fewer`);
  }

  let date = null;
  if (src.date === undefined || src.date === null || src.date === '') {
    if (requireDate) errors.push('date is required');
  } else {
    date = normalizeDate(src.date);
    if (!date) errors.push('date must be a real calendar date in YYYY-MM-DD form');
  }

  let mood = '';
  if (src.mood !== undefined && src.mood !== null && src.mood !== '') {
    mood = String(src.mood);
    if (!MOODS.includes(mood)) {
      errors.push(`mood must be one of: ${MOODS.join(', ')}`);
    }
  }

  if (errors.length) return { ok: false, errors, value: null };

  return { ok: true, errors: [], value: { title, body, date, mood } };
}

/** Build the full DynamoDB item for a new entry. */
function buildEntryItem({ coupleId, entryId, author, value, now }) {
  return {
    pk: partitionKey(coupleId),
    sk: entrySortKey(value.date, entryId),
    entryId,
    date: value.date,
    title: value.title,
    body: value.body,
    mood: value.mood,
    author,
    createdAt: now,
    updatedAt: now,
  };
}

/** Strip internal keys before sending an item to the browser. */
function toPublicEntry(item) {
  if (!item) return null;
  return {
    entryId: item.entryId,
    date: item.date,
    title: item.title || '',
    body: item.body || '',
    mood: item.mood || '',
    author: item.author,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/**
 * Collapse a month's entries into per-day counts for the calendar dots.
 * Shape: { '2026-09-14': { total: 2, authors: ['prakyath','shivani'] } }
 */
function summarizeMonth(entries) {
  const summary = {};
  for (const entry of entries || []) {
    if (!entry || !entry.date) continue;
    if (!summary[entry.date]) summary[entry.date] = { total: 0, authors: [] };
    const day = summary[entry.date];
    day.total += 1;
    if (entry.author && !day.authors.includes(entry.author)) {
      day.authors.push(entry.author);
    }
  }
  return summary;
}

module.exports = {
  MAX_TITLE,
  MAX_BODY,
  MOODS,
  normalizeDate,
  normalizeMonth,
  partitionKey,
  entrySortKey,
  monthPrefix,
  validateEntry,
  buildEntryItem,
  toPublicEntry,
  summarizeMonth,
};
