/**
 * Mana Muchatlu API - a single Lambda behind a Function URL.
 *
 * Routes:
 *   GET    /health                  - liveness, no auth
 *   GET    /members                 - who can write here (no secrets), no auth
 *   POST   /auth/login              - { memberId, passphrase } -> session token
 *   GET    /entries?month=YYYY-MM   - one month of entries + calendar summary
 *   POST   /entries                 - create an entry
 *   PATCH  /entries/{date}/{id}     - edit an entry
 *   DELETE /entries/{date}/{id}     - delete an entry
 *   POST   /media/presign           - a presigned S3 PUT for one photo
 *
 * One function rather than one-per-route: at ~10 writes a week the entire app
 * fits inside a single warm container, and a shared container means a single
 * cold start instead of six.
 */

const crypto = require('crypto');
const {
  DynamoDBClient,
  PutItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand,
} = require('@aws-sdk/client-dynamodb');

const auth = require('./lib/auth');
const entries = require('./lib/entries');
const mediaLib = require('./lib/media');
const { presignS3, credentialsFromEnv } = require('./lib/presign');
const { marshallItem, unmarshallItem, marshall } = require('./lib/ddb');
const { json, methodOf, pathOf, parseBody } = require('./lib/http');

const TABLE_NAME = process.env.TABLE_NAME;
const COUPLE_ID = process.env.COUPLE_ID || 'mana';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const AWS_REGION = process.env.AWS_REGION || 'us-east-1';
const MEMBERS = auth.parseMembers(process.env.MEMBERS);

// How long a photo link stays good. Long enough to browse a month without
// re-fetching, short enough that a link copied out of the page stops working
// well before it could be shared around.
const MEDIA_URL_TTL = 3600;
// ALLOWED_ORIGIN is still set on the function, but deliberately unread here:
// the Function URL's Cors config is the single place CORS is decided.

const ddb = new DynamoDBClient({});

/**
 * CORS is owned entirely by the Function URL's own Cors configuration (see
 * data-stack.yaml), NOT by this handler.
 *
 * When both set the headers, the response carries two
 * Access-Control-Allow-Origin values and every browser rejects it - while
 * curl, which sends no Origin and does not check, reports a perfectly healthy
 * endpoint. That combination (works from the terminal, blocked in the browser)
 * is what a duplicated CORS header looks like from the outside.
 *
 * Letting the URL own it also means preflight is answered by the Lambda
 * service without invoking this function at all.
 */
exports.handler = async (event) => {
  const method = methodOf(event);
  const path = pathOf(event);

  // Reached only if the Function URL has no Cors config of its own; with one,
  // the service answers preflight before this runs.
  if (method === 'OPTIONS') {
    return { statusCode: 204, body: '' };
  }

  try {
    return await route(method, path, event);
  } catch (err) {
    // Log the detail, return none of it - error strings leak schema.
    console.error('unhandled error', { path, method, message: err?.message, stack: err?.stack });
    return json(500, { error: 'something went wrong on our side' });
  }
};

async function route(method, path, event) {
  if (method === 'GET' && path === '/health') {
    return json(200, { ok: true, service: 'mana-muchatlu', members: MEMBERS.length });
  }

  if (method === 'GET' && path === '/members') {
    return json(200, { members: auth.publicMembers(MEMBERS) });
  }

  if (method === 'POST' && path === '/auth/login') {
    return login(event);
  }

  // Everything past this point needs a valid session.
  const claims = auth.verifyToken(auth.bearerFrom(event.headers), SESSION_SECRET);
  if (!claims) {
    return json(401, { error: 'sign in first' });
  }
  const member = MEMBERS.find((m) => m.id === claims.sub);
  if (!member) {
    // Token is validly signed but names someone no longer on the member list.
    return json(401, { error: 'sign in first' });
  }

  if (method === 'GET' && path === '/entries') {
    return listEntries(event);
  }

  if (method === 'POST' && path === '/entries') {
    return createEntry(event, member);
  }

  if (method === 'POST' && path === '/media/presign') {
    return presignUpload(event);
  }

  const entryMatch = /^\/entries\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{1,64})$/.exec(path);
  if (entryMatch) {
    const [, date, entryId] = entryMatch;
    if (method === 'PATCH') return updateEntry(event, member, date, entryId);
    if (method === 'DELETE') return deleteEntry(member, date, entryId);
  }

  return json(404, { error: 'no such route' });
}

async function login(event) {
  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const memberId = String(parsed.value.memberId || '');
  const passphrase = String(parsed.value.passphrase || '');
  const member = MEMBERS.find((m) => m.id === memberId);

  // Always run a scrypt verification, even for an unknown member, so that the
  // response time does not reveal which member ids exist.
  const storedHash = member ? member.passphraseHash : DUMMY_HASH();
  const passphraseOk = auth.verifyPassphrase(passphrase, storedHash);

  if (!member || !passphraseOk) {
    return json(401, { error: 'that passphrase does not match' });
  }

  const token = auth.signToken({ sub: member.id, name: member.name }, SESSION_SECRET);
  return json(200, {
    token,
    member: auth.publicMembers([member])[0],
    expiresIn: auth.TOKEN_TTL_SECONDS,
  });
}

// A fixed well-formed hash of a random value, so the unknown-member path costs
// the same scrypt work as the known-member path.
let dummyHashCache = null;
function DUMMY_HASH() {
  if (!dummyHashCache) {
    dummyHashCache = auth.hashPassphrase(crypto.randomBytes(32).toString('hex'));
  }
  return dummyHashCache;
}

async function listEntries(event) {
  const month = entries.normalizeMonth(event.queryStringParameters?.month);
  if (!month) {
    return json(400, { error: 'month must be supplied as YYYY-MM' });
  }

  const response = await ddb.send(
    new QueryCommand({
      TableName: TABLE_NAME,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: {
        ':pk': marshall(entries.partitionKey(COUPLE_ID)),
        ':prefix': marshall(entries.monthPrefix(month)),
      },
    })
  );

  const now = new Date();
  const items = (response.Items || [])
    .map(unmarshallItem)
    .map(entries.toPublicEntry)
    .map((entry) => withMediaUrls(entry, now));

  // Newest first within the month - the feed reads top-down like a timeline.
  items.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));

  return json(200, { month, entries: items, summary: entries.summarizeMonth(items) });
}

async function createEntry(event, member) {
  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  // Media first: whether there are photos decides whether an entry with no
  // text is empty or perfectly complete.
  //
  // Media keys arrive from the browser, so they are untrusted: validateMedia
  // accepts only keys of the shape this app hands out, under this couple's
  // own prefix.
  const mediaCheck = mediaLib.validateMedia(parsed.value.media, COUPLE_ID);
  if (!mediaCheck.ok) return json(400, { error: mediaCheck.errors[0] });

  const check = entries.validateEntry(parsed.value, { hasMedia: mediaCheck.value.length > 0 });
  if (!check.ok) return json(400, { error: check.errors[0], errors: check.errors });

  const entryId = crypto.randomUUID();
  const item = entries.buildEntryItem({
    coupleId: COUPLE_ID,
    entryId,
    author: member.id,
    value: check.value,
    media: mediaCheck.value,
    now: Date.now(),
  });

  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshallItem(item),
      ConditionExpression: 'attribute_not_exists(sk)',
    })
  );

  return json(201, { entry: withMediaUrls(entries.toPublicEntry(item), new Date()) });
}

async function updateEntry(event, member, date, entryId) {
  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  // The date is part of the key, so an edit keeps the entry on its original
  // day. Moving an entry to another date is a delete plus a create.
  const mediaCheck = mediaLib.validateMedia(parsed.value.media, COUPLE_ID);
  if (!mediaCheck.ok) return json(400, { error: mediaCheck.errors[0] });

  const check = entries.validateEntry(
    { ...parsed.value, date },
    { requireDate: true, hasMedia: mediaCheck.value.length > 0 }
  );
  if (!check.ok) return json(400, { error: check.errors[0], errors: check.errors });

  try {
    const response = await ddb.send(
      new UpdateItemCommand({
        TableName: TABLE_NAME,
        Key: marshallItem({
          pk: entries.partitionKey(COUPLE_ID),
          sk: entries.entrySortKey(date, entryId),
        }),
        // Both of you can edit either entry - it is a shared journal, not two
        // private ones. author stays as whoever first wrote it.
        ConditionExpression: 'attribute_exists(sk)',
        UpdateExpression:
          'SET #title = :title, #body = :body, #mood = :mood, #media = :media, ' +
          '#updatedAt = :now, #editor = :editor',
        // Aliased rather than inlined: DynamoDB has ~570 reserved words and
        // checking each attribute name against that list by hand is a bug
        // waiting for the day someone adds a field called "status".
        ExpressionAttributeNames: {
          '#title': 'title',
          '#body': 'body',
          '#mood': 'mood',
          '#media': 'media',
          '#updatedAt': 'updatedAt',
          '#editor': 'lastEditedBy',
        },
        ExpressionAttributeValues: marshallItem({
          ':title': check.value.title,
          ':body': check.value.body,
          ':mood': check.value.mood,
          ':media': mediaCheck.value,
          ':now': Date.now(),
          ':editor': member.id,
        }),
        ReturnValues: 'ALL_NEW',
      })
    );

    return json(200, {
      entry: withMediaUrls(entries.toPublicEntry(unmarshallItem(response.Attributes)), new Date()),
    });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return json(404, { error: 'that entry is gone' });
    }
    throw err;
  }
}

async function deleteEntry(member, date, entryId) {
  try {
    await ddb.send(
      new DeleteItemCommand({
        TableName: TABLE_NAME,
        Key: marshallItem({
          pk: entries.partitionKey(COUPLE_ID),
          sk: entries.entrySortKey(date, entryId),
        }),
        ConditionExpression: 'attribute_exists(sk)',
      })
    );
    return json(200, { deleted: true, entryId });
  } catch (err) {
    if (err?.name === 'ConditionalCheckFailedException') {
      return json(404, { error: 'that entry is gone' });
    }
    throw err;
  }
}

/**
 * Swap stored media keys for short-lived presigned GET urls.
 *
 * The bucket stays private: nothing in it is world-readable, and every photo
 * is reachable only through a link this function signs for an authenticated
 * member. Signing is pure local crypto - roughly microseconds per photo - so
 * doing it for a whole month of entries on every read costs nothing worth
 * measuring, and it avoids keeping a second, staler copy of the urls anywhere.
 */
function withMediaUrls(entry, now) {
  if (!entry || !Array.isArray(entry.media) || entry.media.length === 0) return entry;
  if (!MEDIA_BUCKET) return entry;

  const credentials = credentialsFromEnv();
  return {
    ...entry,
    media: entry.media.map((item) => ({
      ...item,
      url: presignS3({
        method: 'GET',
        bucket: MEDIA_BUCKET,
        key: item.key,
        region: AWS_REGION,
        credentials,
        expiresIn: MEDIA_URL_TTL,
        now,
      }),
    })),
  };
}

/**
 * Hand the browser a presigned PUT so it can upload straight to S3.
 *
 * The photo never passes through Lambda: no 6MB response limit to bump into,
 * no invocation billed for the transfer, no base64 round trip. The url is
 * good for fifteen minutes, which is long enough for a slow phone upload and
 * short enough to be worthless if it leaks.
 */
async function presignUpload(event) {
  if (!MEDIA_BUCKET) {
    return json(503, { error: 'photo storage is not configured' });
  }

  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const check = mediaLib.validatePresignRequest(parsed.value);
  if (!check.ok) return json(400, { error: check.errors[0] });

  // Group uploads by the entry's month so a prefix listing recovers a month
  // of photos without reading DynamoDB - which the export job will want.
  const month =
    entries.normalizeMonth(parsed.value.month) ||
    new Date().toISOString().slice(0, 7);

  const key = mediaLib.buildMediaKey({
    coupleId: COUPLE_ID,
    month,
    id: crypto.randomUUID(),
    contentType: check.value.contentType,
  });

  const uploadUrl = presignS3({
    method: 'PUT',
    bucket: MEDIA_BUCKET,
    key,
    region: AWS_REGION,
    credentials: credentialsFromEnv(),
    expiresIn: 900,
  });

  return json(200, {
    key,
    uploadUrl,
    method: 'PUT',
    contentType: check.value.contentType,
    expiresIn: 900,
  });
}
