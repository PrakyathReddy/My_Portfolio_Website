/**
 * Media attachments: key construction and validation.
 *
 * Pure functions, like entries.js - no AWS, no I/O.
 *
 * Object keys are laid out so the bucket sorts the way the journal reads:
 *   media/<coupleId>/<YYYY-MM>/<uuid>.<ext>
 * The month segment means a prefix listing recovers a month's photos without
 * consulting DynamoDB, which matters for the export job later on.
 */

const MAX_PER_ENTRY = 10;
const MAX_BYTES = 25 * 1024 * 1024; // 25MB - comfortably above a phone photo

// Allow-list rather than deny-list, and images only for now. Video needs a
// think about playback and transcoding that a still image does not.
const CONTENT_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

function isAllowedContentType(contentType) {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, String(contentType || '').toLowerCase());
}

function extensionFor(contentType) {
  return CONTENT_TYPES[String(contentType || '').toLowerCase()] || 'bin';
}

/**
 * Build the object key for a new upload.
 * The id comes from the caller so this stays pure and testable.
 */
function buildMediaKey({ coupleId, month, id, contentType }) {
  return `media/${coupleId}/${month}/${id}.${extensionFor(contentType)}`;
}

/**
 * Keys are echoed back by the client when it saves an entry, so they are
 * untrusted input. Accept only the shape this app generates: no traversal, no
 * absolute paths, no escaping the media/<couple> prefix.
 */
function isValidMediaKey(key, coupleId) {
  const value = String(key || '');
  if (value.length > 300) return false;
  if (value.includes('..') || value.includes('//') || value.startsWith('/')) return false;

  const pattern = new RegExp(
    `^media/${escapeRegex(coupleId)}/\\d{4}-\\d{2}/[A-Za-z0-9_-]{1,64}\\.[a-z0-9]{1,8}$`
  );
  return pattern.test(value);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Validate the media array supplied with an entry.
 * Returns { ok, errors, value } - same contract as validateEntry.
 */
function validateMedia(input, coupleId) {
  if (input === undefined || input === null || input === '') {
    return { ok: true, errors: [], value: [] };
  }
  if (!Array.isArray(input)) {
    return { ok: false, errors: ['media must be a list'], value: null };
  }
  if (input.length > MAX_PER_ENTRY) {
    return { ok: false, errors: [`at most ${MAX_PER_ENTRY} photos per entry`], value: null };
  }

  const seen = new Set();
  const value = [];

  for (const item of input) {
    const key = typeof item === 'string' ? item : (item && item.key);
    if (!isValidMediaKey(key, coupleId)) {
      return { ok: false, errors: ['that photo reference is not one of ours'], value: null };
    }
    // Duplicates would render twice and double the presigning work.
    if (seen.has(key)) continue;
    seen.add(key);

    const contentType = item && typeof item.contentType === 'string' ? item.contentType : '';
    value.push({
      key,
      contentType: isAllowedContentType(contentType) ? contentType.toLowerCase() : '',
    });
  }

  return { ok: true, errors: [], value };
}

/** Validate a presign request body. */
function validatePresignRequest(input) {
  const src = input && typeof input === 'object' ? input : {};
  const contentType = String(src.contentType || '').toLowerCase();

  if (!isAllowedContentType(contentType)) {
    return {
      ok: false,
      errors: [`photos must be one of: ${Object.keys(CONTENT_TYPES).join(', ')}`],
      value: null,
    };
  }

  // Advisory only - a presigned PUT cannot enforce a size limit on its own.
  // Catching it here keeps an obviously oversized upload from starting.
  const size = Number(src.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    return {
      ok: false,
      errors: [`photos must be under ${Math.round(MAX_BYTES / 1024 / 1024)}MB`],
      value: null,
    };
  }

  return { ok: true, errors: [], value: { contentType, size: Number.isFinite(size) ? size : 0 } };
}

module.exports = {
  MAX_PER_ENTRY,
  MAX_BYTES,
  CONTENT_TYPES,
  isAllowedContentType,
  extensionFor,
  buildMediaKey,
  isValidMediaKey,
  validateMedia,
  validatePresignRequest,
};
