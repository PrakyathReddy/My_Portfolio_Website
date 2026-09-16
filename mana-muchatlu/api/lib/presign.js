/**
 * S3 presigned URLs, signed by hand with AWS Signature Version 4.
 *
 * Why not @aws-sdk/s3-request-presigner: the Lambda runtime bundles the core
 * SDK clients, but not reliably the presigner package, and adding it would put
 * a node_modules install back into a deploy that currently has none. SigV4
 * query signing is about sixty lines of HMAC, and unlike a dependency it is
 * fully deterministic - given fixed credentials and a fixed clock it produces
 * a fixed signature, which is exactly what a unit test needs.
 *
 * Presigned URLs are what let the browser upload straight to S3. The bytes of
 * a photo never pass through Lambda, so there is no payload limit to hit, no
 * invocation billed by the megabyte, and no base64 round trip.
 */

const crypto = require('crypto');

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
// Unsigned payload: the body is signed by neither side, which is what allows
// the browser to stream an arbitrary file to a URL signed before it was read.
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986 encoding. encodeURIComponent leaves !'()* alone; AWS expects them
 * percent-encoded, and a single mismatched character invalidates the whole
 * signature.
 */
function encodeRfc3986(value) {
  return encodeURIComponent(String(value)).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** Object keys keep their slashes as path separators; each segment is encoded. */
function encodeKey(key) {
  return String(key).split('/').map(encodeRfc3986).join('/');
}

/** ISO8601 basic format: 20260915T063000Z */
function amzDate(date) {
  return date.toISOString().replace(/[:-]/g, '').replace(/\.\d{3}/, '');
}

function signingKey(secretAccessKey, datestamp, region) {
  let key = hmac('AWS4' + secretAccessKey, datestamp);
  key = hmac(key, region);
  key = hmac(key, SERVICE);
  return hmac(key, 'aws4_request');
}

/**
 * Build a presigned S3 URL.
 *
 * @param {object}  options
 * @param {string}  options.method       'PUT' to upload, 'GET' to read.
 * @param {string}  options.bucket
 * @param {string}  options.key          Object key, slashes preserved.
 * @param {string}  options.region
 * @param {object}  options.credentials  { accessKeyId, secretAccessKey, sessionToken? }
 * @param {number}  options.expiresIn    Seconds, 1..604800.
 * @param {Date}    options.now          Injectable for deterministic tests.
 * @param {string}  [options.host]       Override the endpoint host. Only used
 *                                       to check this implementation against
 *                                       AWS's published legacy-host test
 *                                       vector; production always uses the
 *                                       regional virtual-hosted form.
 */
function presignS3({
  method = 'GET',
  bucket,
  key,
  region,
  credentials,
  expiresIn = 3600,
  now = new Date(),
  host: hostOverride,
}) {
  if (!bucket) throw new Error('presignS3 requires a bucket');
  if (!key) throw new Error('presignS3 requires a key');
  if (!region) throw new Error('presignS3 requires a region');
  if (!credentials || !credentials.accessKeyId || !credentials.secretAccessKey) {
    throw new Error('presignS3 requires credentials');
  }
  if (!Number.isInteger(expiresIn) || expiresIn < 1 || expiresIn > 604800) {
    throw new Error('expiresIn must be between 1 and 604800 seconds');
  }

  const host = hostOverride || `${bucket}.s3.${region}.amazonaws.com`;
  const timestamp = amzDate(now);
  const datestamp = timestamp.slice(0, 8);
  const scope = `${datestamp}/${region}/${SERVICE}/aws4_request`;

  const params = {
    'X-Amz-Algorithm': ALGORITHM,
    'X-Amz-Credential': `${credentials.accessKeyId}/${scope}`,
    'X-Amz-Date': timestamp,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  // Lambda runs on temporary credentials, which carry a session token that
  // must be part of the signed query string.
  if (credentials.sessionToken) {
    params['X-Amz-Security-Token'] = credentials.sessionToken;
  }

  // Canonical query string: sorted by key, every name and value encoded.
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((name) => `${encodeRfc3986(name)}=${encodeRfc3986(params[name])}`)
    .join('&');

  const canonicalPath = '/' + encodeKey(key);
  const canonicalRequest = [
    method.toUpperCase(),
    canonicalPath,
    canonicalQuery,
    `host:${host}\n`, // canonical headers block ends with a newline
    'host',           // signed headers
    UNSIGNED_PAYLOAD,
  ].join('\n');

  const stringToSign = [ALGORITHM, timestamp, scope, sha256Hex(canonicalRequest)].join('\n');
  const signature = crypto
    .createHmac('sha256', signingKey(credentials.secretAccessKey, datestamp, region))
    .update(stringToSign, 'utf8')
    .digest('hex');

  return `https://${host}${canonicalPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Credentials as the Lambda runtime supplies them. */
function credentialsFromEnv(env = process.env) {
  return {
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN,
  };
}

module.exports = { presignS3, credentialsFromEnv, encodeRfc3986, encodeKey, amzDate };
