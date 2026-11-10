/** @jest-environment node */
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const path = require('path');
const policy = require('../lib/reminders');
const { createNotifications } = require('../notifications');
const { marshallItem, unmarshallItem } = require('../lib/ddb');
const clock = Date.parse('2026-11-10T16:30:00Z'); // delivery window tests use the exact schedule below
const due = Date.parse('2026-11-10T16:30:00Z') - 30 * 60000;
const members = [{ id: 'bujjuluu', name: 'Shivani' }, { id: 'bangarammm', name: 'Prakyath' }];
function subscription(suffix = 'one') {
  const key = crypto.createECDH('prime256v1'); key.generateKeys();
  return { endpoint: 'https://web.push.apple.com/' + suffix,
    keys: { p256dh: key.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') } };
}
class QueryCommand { constructor(input) { this.input = input; } }
class UpdateItemCommand { constructor(input) { this.input = input; } }
class DeleteItemCommand { constructor(input) { this.input = input; } }
function fixture(sendNotification = jest.fn(async () => ({ statusCode: 201 }))) {
  const records = new Map(), calls = [];
  const conditional = () => { const e = new Error('condition'); e.name = 'ConditionalCheckFailedException'; throw e; };
  const ddb = { send: jest.fn(async command => {
    const i = command.input, v = unmarshallItem(i.ExpressionAttributeValues || {});
    calls.push(i);
    if (command instanceof QueryCommand) {
      expect(v[':pk']).toBe('REMINDERS#mana');
      return { Items: [...records.values()].filter(r => !v[':sk'] || r.sk === v[':sk']).map(marshallItem) };
    }
    const k = unmarshallItem(i.Key); expect(k.pk).toBe('REMINDERS#mana');
    let item = records.get(k.sk);
    if (command instanceof DeleteItemCommand) {
      if (i.ConditionExpression && (!item || item.reminderLease !== v[':lease'] || item.memberId !== v[':member'])) conditional();
      records.delete(k.sk); return {};
    }
    if (i.UpdateExpression.includes('createdAt')) {
      item = { ...k, ...item, memberId: v[':member'], subscription: v[':subscription'], updatedAt: v[':now'], createdAt: item?.createdAt || v[':now'] };
    } else if (i.UpdateExpression.startsWith('SET reminderLease')) {
      if (!item || item.memberId !== v[':member'] || item.lastSentDate === v[':date'] || item.leaseUntil >= v[':now']) conditional();
      item = { ...item, reminderLease: v[':lease'], leaseUntil: v[':until'] };
    } else {
      if (!item || item.memberId !== v[':member'] || item.reminderLease !== v[':lease']) conditional();
      item = { ...item }; delete item.reminderLease; delete item.leaseUntil;
      if (v[':date']) item.lastSentDate = v[':date'];
    }
    records.set(k.sk, item); return {};
  }) };
  const service = createNotifications({ ddb, commands: { QueryCommand, UpdateItemCommand, DeleteItemCommand },
    tableName: 'existing-journal-table', coupleId: 'mana', members, secret: 'test-session-secret-at-least-32-characters',
    origin: 'https://mana-muchatlu-shivani.prakyath.dev', sendNotification, now: () => due + 1000 });
  const event = { time: new Date(due).toISOString() };
  return { service, records, calls, sendNotification, event };
}

test('sixty distinct messages rotate continuously across month boundaries, with no repeat within sixty days', () => {
  expect(policy.MESSAGES).toHaveLength(60);
  expect(new Set(policy.MESSAGES).size).toBe(60);
  const bodies = Array.from({ length: 60 }, (_, index) => policy.reminder(members[0], due + index * 86400000).body);
  expect(new Set(bodies).size).toBe(60);
  expect(policy.reminder(members[0], due + 60 * 86400000).body).toBe(bodies[0]);
  expect(bodies.every(body => !body.includes('{') && body.length < 160)).toBe(true);
});
test('uses ve/bujji and ra/bangaaramm for the actual configured member IDs', () => {
  const firstMessage = 60 * 86400000 + 16 * 3600000;
  expect(policy.reminder(members[0], firstMessage).body).toContain('raya ve');
  expect(policy.reminder(members[1], firstMessage).body).toContain('raya ra');
  expect(JSON.stringify(policy.reminder(members[0], due))).not.toContain('Original words');
});
test('dates and schedule are anchored to India, regardless of server/device timezone', () => {
  expect(policy.SCHEDULE).toEqual({ time: '21:30', timeZone: 'Asia/Kolkata' });
  expect(policy.localDate('2026-11-10T19:00:00Z')).toBe('2026-11-11');
  expect(policy.scheduledTime({ time: new Date(due).toISOString() }, due + 1000)).toBe(due);
  expect(policy.scheduledTime({ time: new Date(due).toISOString() }, due + 16 * 60000)).toBeNull();
  expect(policy.scheduledTime({ time: new Date(clock).toISOString() }, clock)).toBeNull();
});
test.each(['http://web.push.apple.com/token', 'https://web.push.apple.com.evil.test/token', 'https://127.0.0.1/token',
  'https://fcm.googleapis.com:444/token', 'https://user:pass@fcm.googleapis.com/token', 'https://example.com/token'])('rejects unsafe endpoint %s', endpoint => {
  expect(policy.validateEndpoint(endpoint)).toBe(false);
});
test('validates real P-256 subscription keys and strips untrusted extra fields', () => {
  const good = subscription(); expect(policy.validateSubscription(good)).toEqual({ ok: true, value: good });
  expect(policy.validateSubscription({ ...good, keys: { ...good.keys, auth: 'short' } }).ok).toBe(false);
  expect(policy.validateSubscription({ ...good, keys: { ...good.keys, p256dh: Buffer.alloc(65, 4).toString('base64url') } }).ok).toBe(false);
  expect(policy.validateSubscription({ ...good, memberId: 'someone-else' }).value).not.toHaveProperty('memberId');
});
test('derives stable domain-separated keys and never returns the private key in public config', () => {
  const secret = 'high-entropy-test-secret-at-least-32-characters';
  const a = policy.vapidKeys(secret, 'mana', 'https://example.test');
  expect(policy.vapidKeys(secret, 'mana', 'https://example.test')).toEqual(a);
  expect(policy.vapidKeys(secret, 'other', 'https://example.test')).not.toEqual(a);
  expect(policy.vapidKeys(secret, 'mana', 'https://other.test')).not.toEqual(a);
  expect(Buffer.from(a.publicKey, 'base64url')).toHaveLength(65);
  const config = fixture().service.config();
  expect(config.messageCount).toBe(60); expect(config).not.toHaveProperty('privateKey');
  expect(JSON.stringify(config)).not.toContain('session-secret');
});
test('pinned Web Push library creates an encrypted VAPID request under the actual Node module loader', () => {
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    import * as webpush from 'web-push';
    import crypto from 'node:crypto';
    const require=createRequire(import.meta.url), p=require('./api/lib/reminders.js');
    const keys=p.vapidKeys('test-secret-with-more-than-32-characters','mana','https://example.test');
    const ecdh=crypto.createECDH('prime256v1'); ecdh.generateKeys();
    const sub={endpoint:'https://web.push.apple.com/test',keys:{p256dh:ecdh.getPublicKey().toString('base64url'),auth:crypto.randomBytes(16).toString('base64url')}};
    const request=webpush.generateRequestDetails(sub,'private reminder',{vapidDetails:{subject:'https://example.test',...keys},contentEncoding:'aes128gcm',TTL:3600});
    console.log(JSON.stringify({encrypted:!request.body.includes(Buffer.from('private reminder')),authorization:request.headers.Authorization.startsWith('vapid '),encoding:request.headers['Content-Encoding']}));
  `], { cwd: path.join(__dirname, '../..'), encoding: 'utf8' });
  expect(JSON.parse(output)).toEqual({ encrypted: true, authorization: true, encoding: 'aes128gcm' });
});
test('subscription refresh preserves delivery history and binds to the authenticated member', async () => {
  const f = fixture(), sub = subscription();
  await f.service.subscribe(members[0], sub);
  const item = f.records.get(policy.deviceKey(sub.endpoint)); item.lastSentDate = '2026-11-10';
  await f.service.subscribe(members[1], sub);
  expect(f.records.get(item.sk)).toMatchObject({ memberId: 'bangarammm', lastSentDate: '2026-11-10' });
});
test('concurrent scheduled deliveries and subsequent retries send only once per device per India date', async () => {
  const f = fixture(); await f.service.subscribe(members[0], subscription());
  const results = await Promise.all([f.service.nightly(f.event), f.service.nightly(f.event)]);
  expect(results.reduce((sum, r) => sum + r.sent, 0)).toBe(1);
  await f.service.nightly(f.event); expect(f.sendNotification).toHaveBeenCalledTimes(1);
  const payload = JSON.parse(f.sendNotification.mock.calls[0][1]);
  expect(payload).toMatchObject({ kind: 'journal-reminder', url: '/', tag: 'mana-reminder-2026-11-10' });
});
test('expired endpoints are removed and transient failures remain retryable', async () => {
  const send = jest.fn().mockRejectedValueOnce({ statusCode: 503 }).mockResolvedValueOnce({ statusCode: 201 }).mockRejectedValueOnce({ statusCode: 410 });
  const f = fixture(send), one = subscription(); await f.service.subscribe(members[0], one);
  await expect(f.service.nightly(f.event)).rejects.toThrow('could not be delivered');
  await expect(f.service.nightly(f.event)).resolves.toMatchObject({ sent: 1 });
  await f.service.subscribe(members[1], subscription('two'));
  await expect(f.service.nightly(f.event)).resolves.toMatchObject({ expired: 1 });
  expect(f.records.size).toBe(1);
});
test('test notifications require device ownership and do not suppress the nightly reminder', async () => {
  const f = fixture(), sub = subscription(); await f.service.subscribe(members[0], sub);
  expect((await f.service.test(members[1], sub.endpoint)).status).toBe(404);
  expect(f.sendNotification).not.toHaveBeenCalled();
  expect((await f.service.test(members[0], sub.endpoint)).data.sent).toBe(true);
  expect((await f.service.nightly(f.event)).sent).toBe(1);
});
test('opt-out removes only that reminder record; stale scheduled events do no I/O', async () => {
  const f = fixture(), sub = subscription(); await f.service.subscribe(members[0], sub);
  await f.service.unsubscribe(sub.endpoint); expect(f.records.size).toBe(0);
  const before = f.calls.length;
  expect(await f.service.nightly({ time: new Date(due - 86400000).toISOString() })).toEqual({ skipped: 'outside reminder window' });
  expect(f.calls).toHaveLength(before);
});
