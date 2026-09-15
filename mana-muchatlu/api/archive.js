/**
 * Mana Muchatlu - archive and weekly report.
 *
 * A second handler sharing the API's code bundle, invoked by EventBridge:
 *
 *   { "job": "archive" }  nightly  - snapshot every entry to the backup bucket
 *   { "job": "report" }   weekly   - verify the snapshot, then send one email
 *
 * Why the report also verifies: a backup that reports nothing is
 * indistinguishable from a backup that stopped running, and the difference
 * only shows up on the day it matters. The weekly mail re-reads the archive
 * it is reporting on, so a broken job announces itself within seven days
 * instead of being discovered during a restore.
 *
 * What this does NOT protect against, deliberately stated: the backup bucket
 * is in the same AWS account as the data. Versioning and point-in-time
 * recovery both die with the account. The off-account copy is infra/pull-backup.sh,
 * run by a person - see the README.
 */

const {
  DynamoDBClient,
  QueryCommand,
} = require('@aws-sdk/client-dynamodb');
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
} = require('@aws-sdk/client-s3');
const { SNSClient, PublishCommand } = require('@aws-sdk/client-sns');

const auth = require('./lib/auth');
const entriesLib = require('./lib/entries');
const archiveLib = require('./lib/archive');
const { marshall, unmarshallItem } = require('./lib/ddb');

const TABLE_NAME = process.env.TABLE_NAME;
const COUPLE_ID = process.env.COUPLE_ID || 'mana';
const BACKUP_BUCKET = process.env.BACKUP_BUCKET || '';
const MEDIA_BUCKET = process.env.MEDIA_BUCKET || '';
const TOPIC_ARN = process.env.TOPIC_ARN || '';
const MEMBERS = auth.parseMembers(process.env.MEMBERS);

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const sns = new SNSClient({});

exports.handler = async (event) => {
  const job = (event && event.job) || 'archive';
  console.log('archive job starting', { job });

  if (job === 'archive') return runArchive();
  if (job === 'report') return runReport();

  throw new Error(`unknown job: ${job}`);
};

/** Every entry for this couple. One partition, so one Query, paginated. */
async function readAllEntries() {
  const items = [];
  let startKey;

  do {
    const response = await ddb.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: {
          ':pk': marshall(entriesLib.partitionKey(COUPLE_ID)),
          ':prefix': marshall('ENTRY#'),
        },
        ExclusiveStartKey: startKey,
      })
    );

    for (const item of response.Items || []) {
      items.push(entriesLib.toPublicEntry(unmarshallItem(item)));
    }
    startKey = response.LastEvaluatedKey;
  } while (startKey);

  return items;
}

/** Count objects under the media prefix, for the report's photo figure. */
async function countMediaObjects() {
  if (!MEDIA_BUCKET) return { objects: 0, bytes: 0 };

  let objects = 0;
  let bytes = 0;
  let token;

  do {
    const response = await s3.send(
      new ListObjectsV2Command({
        Bucket: MEDIA_BUCKET,
        Prefix: `media/${COUPLE_ID}/`,
        ContinuationToken: token,
      })
    );
    for (const object of response.Contents || []) {
      objects += 1;
      bytes += object.Size || 0;
    }
    token = response.IsTruncated ? response.NextContinuationToken : undefined;
  } while (token);

  return { objects, bytes };
}

async function putJson(key, value) {
  await s3.send(
    new PutObjectCommand({
      Bucket: BACKUP_BUCKET,
      Key: key,
      Body: JSON.stringify(value, null, 2),
      ContentType: 'application/json',
    })
  );
}

async function getJson(key) {
  try {
    const response = await s3.send(
      new GetObjectCommand({ Bucket: BACKUP_BUCKET, Key: key })
    );
    const text = await response.Body.transformToString();
    return JSON.parse(text);
  } catch (err) {
    // Missing or unparseable both mean "no usable archive", which is what the
    // caller needs to know; the distinction goes in the log, not the return.
    console.warn('could not read archive', { key, message: err && err.message });
    return null;
  }
}

async function runArchive() {
  if (!BACKUP_BUCKET) throw new Error('BACKUP_BUCKET is not configured');

  const now = Date.now();
  const entries = await readAllEntries();
  const archive = archiveLib.buildArchive({
    entries,
    coupleId: COUPLE_ID,
    members: auth.publicMembers(MEMBERS),
    now,
  });

  // Refuse to overwrite a healthy archive with a broken one. A backup job
  // that faithfully preserves corruption is worse than one that stops.
  const verification = archiveLib.verifyArchive(archive);
  if (!verification.ok) {
    console.error('refusing to write a failing archive', verification.problems);
    throw new Error(`archive failed verification: ${verification.problems.join('; ')}`);
  }

  const dateIso = new Date(now).toISOString().slice(0, 10);
  const key = archiveLib.archiveKey(dateIso);

  await putJson(key, archive);
  // A fixed pointer so a restore never has to list the bucket to begin.
  await putJson(archiveLib.latestKey(), archive);

  const summary = archiveLib.summarizeArchive(archive);
  console.log('archive written', { key, ...summary });

  return { ok: true, key, ...summary };
}

async function runReport() {
  const now = Date.now();

  const archive = await getJson(archiveLib.latestKey());
  const verification = archive
    ? archiveLib.verifyArchive(archive)
    : { ok: false, problems: ['no archive found in the backup bucket'] };
  const summary = archiveLib.summarizeArchive(archive);

  const report = archiveLib.buildWeeklyReport({
    archive: archive || { entries: [] },
    summary,
    verification,
    now,
    members: MEMBERS,
  });

  // Cross-check the archive against what is actually in the media bucket.
  // The archive counts what it believes it referenced; this counts what is
  // really stored. A gap between them is worth seeing.
  let body = report.body;
  try {
    const media = await countMediaObjects();
    const megabytes = (media.bytes / 1024 / 1024).toFixed(1);
    body += `\n\nPhotos in storage: ${media.objects} files, ${megabytes} MB.`;
    if (verification.ok && media.objects < summary.photos) {
      body += `\nNOTE: the journal references ${summary.photos} photos but only ` +
              `${media.objects} are stored.`;
    }
  } catch (err) {
    console.warn('could not count media', { message: err && err.message });
  }

  body += '\n\nhttps://mana-muchatlu-shivani.prakyath.dev';

  if (TOPIC_ARN) {
    await sns.send(
      new PublishCommand({
        TopicArn: TOPIC_ARN,
        Subject: report.subject.slice(0, 100), // SNS caps subjects at 100 chars
        Message: body,
      })
    );
  } else {
    console.warn('TOPIC_ARN not set - report not sent');
  }

  console.log('report sent', { subject: report.subject, verified: verification.ok });
  return { ok: verification.ok, subject: report.subject };
}
