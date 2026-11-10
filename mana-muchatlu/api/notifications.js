/** Push subscription storage and delivery. Existing journal partitions are never read or written. */
const crypto = require('crypto');
const policy = require('./lib/reminders');
const { marshall, marshallItem, unmarshallItem } = require('./lib/ddb');

function createNotifications({ ddb, commands, tableName, coupleId, members, secret, origin,
  sendNotification = async (...args) => (await import('web-push')).sendNotification(...args), now = Date.now }) {
  const { QueryCommand, UpdateItemCommand, DeleteItemCommand } = commands;
  const pk = policy.partition(coupleId);
  let keys;
  function config() {
    keys = keys || policy.vapidKeys(secret, coupleId, origin);
    return { publicKey: keys.publicKey, schedule: policy.SCHEDULE, messageCount: policy.MESSAGES.length };
  }
  function key(endpoint) { return marshallItem({ pk, sk: policy.deviceKey(endpoint) }); }
  async function devices(endpoint) {
    const items = [];
    let cursor;
    do {
      const result = await ddb.send(new QueryCommand({ TableName: tableName,
        KeyConditionExpression: endpoint ? 'pk = :pk AND sk = :sk' : 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': marshall(pk), ...(endpoint ? { ':sk': marshall(policy.deviceKey(endpoint)) } : { ':prefix': marshall('DEVICE#') }) },
        ConsistentRead: true, ExclusiveStartKey: cursor,
      }));
      items.push(...(result.Items || []).map(unmarshallItem)); cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async function subscribe(member, subscription) {
    const check = policy.validateSubscription(subscription);
    if (!check.ok) return { status: 400, data: { error: check.error } };
    config();
    const existing = await devices();
    if (existing.length >= 20 && !existing.some(item => item.sk === policy.deviceKey(check.value.endpoint))) {
      return { status: 409, data: { error: 'too many devices; turn off reminders on an unused device first' } };
    }
    // Update, rather than Put: refreshing a subscription must retain delivery deduplication.
    await ddb.send(new UpdateItemCommand({ TableName: tableName, Key: key(check.value.endpoint),
      UpdateExpression: 'SET memberId = :member, subscription = :subscription, updatedAt = :now, createdAt = if_not_exists(createdAt, :now)',
      ExpressionAttributeValues: marshallItem({ ':member': member.id, ':subscription': check.value, ':now': now() }),
    }));
    return { status: 200, data: { enabled: true, schedule: policy.SCHEDULE } };
  }
  async function unsubscribe(endpoint) {
    if (!policy.validateEndpoint(endpoint)) return { status: 400, data: { error: 'invalid push endpoint' } };
    await ddb.send(new DeleteItemCommand({ TableName: tableName, Key: key(endpoint) }));
    return { status: 200, data: { enabled: false } };
  }
  function options(payload) {
    config();
    return { vapidDetails: { subject: origin, ...keys }, TTL: 3600, urgency: 'normal',
      topic: crypto.createHash('sha256').update(payload.tag).digest('base64url').slice(0, 32),
      contentEncoding: 'aes128gcm', timeout: 3000 };
  }
  async function test(member, endpoint) {
    if (!policy.validateEndpoint(endpoint)) return { status: 400, data: { error: 'invalid push endpoint' } };
    const [device] = await devices(endpoint);
    if (!device || device.memberId !== member.id) return { status: 404, data: { error: 'enable reminders on this device first' } };
    const payload = { ...policy.reminder(member, now()), tag: 'mana-reminder-test',
      body: 'It’s journal time ♥ Test reminder vachindi! Daily 9:30 PM ki kaluddam.' };
    try { await sendNotification(device.subscription, JSON.stringify(payload), options(payload)); }
    catch (err) {
      if ([404, 410].includes(err.statusCode)) {
        await unsubscribe(endpoint);
        return { status: 410, data: { error: 'this subscription expired; turn reminders off and enable them again' } };
      }
      throw new Error('could not send the test reminder');
    }
    return { status: 200, data: { sent: true } };
  }
  async function claim(device, date, lease) {
    try {
      await ddb.send(new UpdateItemCommand({ TableName: tableName, Key: marshallItem({ pk, sk: device.sk }),
        UpdateExpression: 'SET reminderLease = :lease, leaseUntil = :until',
        ConditionExpression: 'attribute_exists(sk) AND memberId = :member AND (attribute_not_exists(lastSentDate) OR lastSentDate <> :date) AND (attribute_not_exists(leaseUntil) OR leaseUntil < :now)',
        ExpressionAttributeValues: marshallItem({ ':lease': lease, ':until': now() + 45000, ':member': device.memberId, ':date': date, ':now': now() }),
      }));
      return true;
    } catch (err) { if (err.name === 'ConditionalCheckFailedException') return false; throw err; }
  }
  async function finish(device, lease, success, date) {
    try {
      await ddb.send(new UpdateItemCommand({ TableName: tableName, Key: marshallItem({ pk, sk: device.sk }),
        UpdateExpression: success ? 'SET lastSentDate = :date REMOVE reminderLease, leaseUntil' : 'REMOVE reminderLease, leaseUntil',
        ConditionExpression: 'attribute_exists(sk) AND reminderLease = :lease AND memberId = :member',
        ExpressionAttributeValues: marshallItem({ ':lease': lease, ':member': device.memberId, ...(success ? { ':date': date } : {}) }),
      }));
    } catch (err) { if (err.name !== 'ConditionalCheckFailedException') throw err; }
  }
  async function nightly(event) {
    const time = policy.scheduledTime(event, now());
    if (time === null) return { skipped: 'outside reminder window' };
    const date = policy.localDate(time);
    const all = await devices();
    const stats = { sent: 0, expired: 0, skipped: 0, failed: 0 };
    // At most twenty devices; parallel bounded 3-second requests fit the existing 10-second API Lambda.
    await Promise.all(all.map(async device => {
      const member = members.find(m => m.id === device.memberId);
      if (!member || !policy.validateSubscription(device.subscription).ok) { stats.skipped++; return; }
      const lease = crypto.randomUUID();
      if (!await claim(device, date, lease)) { stats.skipped++; return; }
      const payload = policy.reminder(member, time);
      try {
        await sendNotification(device.subscription, JSON.stringify(payload), options(payload));
        await finish(device, lease, true, date); stats.sent++;
      } catch (err) {
        if ([404, 410].includes(err.statusCode)) {
          try {
            await ddb.send(new DeleteItemCommand({ TableName: tableName, Key: marshallItem({ pk, sk: device.sk }),
              ConditionExpression: 'reminderLease = :lease AND memberId = :member',
              ExpressionAttributeValues: marshallItem({ ':lease': lease, ':member': device.memberId }) }));
          } catch (deleteError) { if (deleteError.name !== 'ConditionalCheckFailedException') throw deleteError; }
          stats.expired++;
        } else { await finish(device, lease, false, date); stats.failed++; }
      }
    }));
    // Counts only: never log endpoints, keys, tokens, payloads or member secrets.
    console.info('nightly reminder delivery', stats);
    if (stats.failed) throw new Error('some nightly reminders could not be delivered');
    return stats;
  }
  return { config, subscribe, unsubscribe, test, nightly };
}
module.exports = { createNotifications };
