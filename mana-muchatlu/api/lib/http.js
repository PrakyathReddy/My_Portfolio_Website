/**
 * Request/response helpers for a Lambda Function URL (payload format 2.0).
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function corsHeaders(allowedOrigin) {
  return {
    'access-control-allow-origin': allowedOrigin || '*',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(statusCode, body, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...JSON_HEADERS, ...extraHeaders },
    body: JSON.stringify(body),
  };
}

function methodOf(event) {
  return String(event?.requestContext?.http?.method || 'GET').toUpperCase();
}

/** Path without the stage prefix, no trailing slash (but never empty). */
function pathOf(event) {
  const raw = String(event?.rawPath || '/');
  const trimmed = raw.replace(/\/+$/, '');
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Parse a JSON request body. Returns { ok, value, error } rather than throwing
 * so that malformed input becomes a 400, never a 500.
 */
function parseBody(event) {
  const raw = event?.body;
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: {} };

  let text = raw;
  if (event.isBase64Encoded) {
    try {
      text = Buffer.from(raw, 'base64').toString('utf8');
    } catch {
      return { ok: false, value: null, error: 'body was not valid base64' };
    }
  }

  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, value: null, error: 'body must be a JSON object' };
    }
    return { ok: true, value: parsed };
  } catch {
    return { ok: false, value: null, error: 'body was not valid JSON' };
  }
}

module.exports = { json, corsHeaders, methodOf, pathOf, parseBody };
