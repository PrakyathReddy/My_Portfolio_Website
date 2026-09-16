/**
 * Request/response helpers for a Lambda Function URL (payload format 2.0).
 */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

// No CORS helper here on purpose. The Function URL's own Cors config sets
// those headers; a handler that set them too would send two
// Access-Control-Allow-Origin values, which browsers reject outright while
// curl reports the endpoint perfectly healthy.

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

module.exports = { json, methodOf, pathOf, parseBody };
