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
const MAX_BYTES = 25 * 1024 * 1024; // 25MB - above a phone photo, ~40min of opus

// Allow-list rather than deny-list. Images and audio; video still needs a
// think about playback and transcoding that neither of these does.
//
// The audio list is wider than it looks like it needs to be because
// MediaRecorder gives a different container per browser and there is no
// negotiating with it: Chrome and Android produce audio/webm, Safari and iOS
// produce audio/mp4. Both have to be accepted or half the devices cannot
// record at all.
const CONTENT_TYPES = {
  'image/jpeg': { ext: 'jpg', kind: 'image' },
  'image/png': { ext: 'png', kind: 'image' },
  'image/webp': { ext: 'webp', kind: 'image' },
  'image/gif': { ext: 'gif', kind: 'image' },
  'image/heic': { ext: 'heic', kind: 'image' },
  'image/heif': { ext: 'heif', kind: 'image' },

  'audio/webm': { ext: 'webm', kind: 'audio' }, // Chrome, Android
  'audio/mp4': { ext: 'm4a', kind: 'audio' },   // Safari, iOS
  'audio/mpeg': { ext: 'mp3', kind: 'audio' },
  'audio/ogg': { ext: 'ogg', kind: 'audio' },
  'audio/wav': { ext: 'wav', kind: 'audio' },
  'audio/aac': { ext: 'aac', kind: 'audio' },
};

/**
 * MediaRecorder reports types with codec parameters attached, like
 * "audio/webm;codecs=opus". The parameters are the browser's business, not
 * ours - match on the base type.
 */
function baseContentType(contentType) {
  return String(contentType || '').toLowerCase().split(';')[0].trim();
}

function isAllowedContentType(contentType) {
  return Object.prototype.hasOwnProperty.call(CONTENT_TYPES, baseContentType(contentType));
}

function extensionFor(contentType) {
  const entry = CONTENT_TYPES[baseContentType(contentType)];
  return entry ? entry.ext : 'bin';
}

/** 'image', 'audio', or '' when the type is not one we accept. */
function kindFor(contentType) {
  const entry = CONTENT_TYPES[baseContentType(contentType)];
  return entry ? entry.kind : '';
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
    return { ok: false, errors: [`at most ${MAX_PER_ENTRY} attachments per entry`], value: null };
  }

  const seen = new Set();
  const value = [];

  for (const item of input) {
    const key = typeof item === 'string' ? item : (item && item.key);
    if (!isValidMediaKey(key, coupleId)) {
      return { ok: false, errors: ['that attachment reference is not one of ours'], value: null };
    }
    // Duplicates would render twice and double the presigning work.
    if (seen.has(key)) continue;
    seen.add(key);

    const contentType = item && typeof item.contentType === 'string' ? item.contentType : '';
    const accepted = isAllowedContentType(contentType) ? baseContentType(contentType) : '';

    // Duration is the client's word for how long a recording is, used only to
    // label the player before the audio loads. Clamped rather than trusted,
    // and floored rather than rounded: the label sitting a fraction under the
    // player's own figure looks right, sitting over it looks broken.
    const rawDuration = item && Number(item.duration);
    const duration = Number.isFinite(rawDuration) && rawDuration > 0
      ? Math.min(Math.floor(rawDuration), 24 * 60 * 60)
      : 0;

    value.push({
      key,
      contentType: accepted,
      kind: kindFor(accepted),
      duration,
    });
  }

  return { ok: true, errors: [], value };
}

/** Validate a presign request body. */
function validatePresignRequest(input) {
  const src = input && typeof input === 'object' ? input : {};
  const contentType = baseContentType(src.contentType);

  if (!isAllowedContentType(contentType)) {
    return {
      ok: false,
      errors: [`attachments must be one of: ${Object.keys(CONTENT_TYPES).join(', ')}`],
      value: null,
    };
  }

  // Advisory only - a presigned PUT cannot enforce a size limit on its own.
  // Catching it here keeps an obviously oversized upload from starting.
  const size = Number(src.size);
  if (Number.isFinite(size) && size > MAX_BYTES) {
    return {
      ok: false,
      errors: [`attachments must be under ${Math.round(MAX_BYTES / 1024 / 1024)}MB`],
      value: null,
    };
  }

  return {
    ok: true,
    errors: [],
    value: {
      contentType: baseContentType(contentType),
      kind: kindFor(contentType),
      size: Number.isFinite(size) ? size : 0,
    },
  };
}

module.exports = {
  MAX_PER_ENTRY,
  MAX_BYTES,
  CONTENT_TYPES,
  isAllowedContentType,
  baseContentType,
  extensionFor,
  kindFor,
  buildMediaKey,
  isValidMediaKey,
  validateMedia,
  validatePresignRequest,
};
