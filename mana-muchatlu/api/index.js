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
const { marshallItem, unmarshallItem, marshall } = require('./lib/ddb');
const { json, corsHeaders, methodOf, pathOf, parseBody } = require('./lib/http');

const TABLE_NAME = process.env.TABLE_NAME;
const COUPLE_ID = process.env.COUPLE_ID || 'mana';
const SESSION_SECRET = process.env.SESSION_SECRET || '';
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const MEMBERS = auth.parseMembers(process.env.MEMBERS);

const ddb = new DynamoDBClient({});

exports.handler = async (event) => {
  const cors = corsHeaders(ALLOWED_ORIGIN);
  const method = methodOf(event);
  const path = pathOf(event);

  if (method === 'OPTIONS') {
    return { statusCode: 204, headers: cors, body: '' };
  }

  try {
    const result = await route(method, path, event);
    return { ...result, headers: { ...result.headers, ...cors } };
  } catch (err) {
    // Log the detail, return none of it - error strings leak schema.
    console.error('unhandled error', { path, method, message: err?.message, stack: err?.stack });
    return json(500, { error: 'something went wrong on our side' }, cors);
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

  const items = (response.Items || []).map(unmarshallItem).map(entries.toPublicEntry);
  // Newest first within the month - the feed reads top-down like a timeline.
  items.sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));

  return json(200, { month, entries: items, summary: entries.summarizeMonth(items) });
}

async function createEntry(event, member) {
  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  const check = entries.validateEntry(parsed.value);
  if (!check.ok) return json(400, { error: check.errors[0], errors: check.errors });

  const entryId = crypto.randomUUID();
  const item = entries.buildEntryItem({
    coupleId: COUPLE_ID,
    entryId,
    author: member.id,
    value: check.value,
    now: Date.now(),
  });

  await ddb.send(
    new PutItemCommand({
      TableName: TABLE_NAME,
      Item: marshallItem(item),
      ConditionExpression: 'attribute_not_exists(sk)',
    })
  );

  return json(201, { entry: entries.toPublicEntry(item) });
}

async function updateEntry(event, member, date, entryId) {
  const parsed = parseBody(event);
  if (!parsed.ok) return json(400, { error: parsed.error });

  // The date is part of the key, so an edit keeps the entry on its original
  // day. Moving an entry to another date is a delete plus a create.
  const check = entries.validateEntry({ ...parsed.value, date }, { requireDate: true });
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
          'SET #title = :title, #body = :body, #mood = :mood, #updatedAt = :now, #editor = :editor',
        // Aliased rather than inlined: DynamoDB has ~570 reserved words and
        // checking each attribute name against that list by hand is a bug
        // waiting for the day someone adds a field called "status".
        ExpressionAttributeNames: {
          '#title': 'title',
          '#body': 'body',
          '#mood': 'mood',
          '#updatedAt': 'updatedAt',
          '#editor': 'lastEditedBy',
        },
        ExpressionAttributeValues: marshallItem({
          ':title': check.value.title,
          ':body': check.value.body,
          ':mood': check.value.mood,
          ':now': Date.now(),
          ':editor': member.id,
        }),
        ReturnValues: 'ALL_NEW',
      })
    );

    return json(200, { entry: entries.toPublicEntry(unmarshallItem(response.Attributes)) });
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
