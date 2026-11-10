/** @jest-environment node */
const auth = require('../lib/auth');
const mockNotifications = { config: jest.fn(() => ({ publicKey: 'public-only' })),
  subscribe: jest.fn(async () => ({ status: 200, data: { enabled: true } })),
  unsubscribe: jest.fn(async () => ({ status: 200, data: { enabled: false } })),
  test: jest.fn(async () => ({ status: 200, data: { sent: true } })), nightly: jest.fn(async () => ({ sent: 0 })) };
jest.mock('../notifications', () => ({ createNotifications: () => mockNotifications }));
jest.mock('@aws-sdk/client-dynamodb', () => ({ DynamoDBClient: class {}, PutItemCommand: class {},
  QueryCommand: class {}, UpdateItemCommand: class {}, DeleteItemCommand: class {} }), { virtual: true });
const previous = { secret: process.env.SESSION_SECRET, members: process.env.MEMBERS };
process.env.SESSION_SECRET = 'a-test-session-secret-with-at-least-32-characters';
process.env.MEMBERS = JSON.stringify([{ id: 'bujjuluu', name: 'Shivani', passphraseHash: auth.hashPassphrase('development-only') }]);
const { handler } = require('../index');
const token = auth.signToken({ sub: 'bujjuluu', name: 'Shivani' }, process.env.SESSION_SECRET);
afterAll(() => {
  for (const [key, value] of [['SESSION_SECRET', previous.secret], ['MEMBERS', previous.members]]) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
beforeEach(() => jest.clearAllMocks());
function http(path, method, body, signed = true) {
  return { rawPath: path, requestContext: { http: { method } },
    headers: signed ? { authorization: 'Bearer ' + token } : {}, body: JSON.stringify(body || {}) };
}
test('all notification routes require an existing member session', async () => {
  for (const [path, method] of [['/notifications/config', 'GET'], ['/notifications/subscribe', 'POST'], ['/notifications/unsubscribe', 'POST'], ['/notifications/test', 'POST']]) {
    expect((await handler(http(path, method, {}, false))).statusCode).toBe(401);
  }
  expect(mockNotifications.subscribe).not.toHaveBeenCalled();
});
test('subscribe and test are bound to the verified token, not an arbitrary member ID in user JSON', async () => {
  expect((await handler(http('/notifications/subscribe', 'POST', { memberId: 'bangarammm', subscription: { endpoint: 'test' } }))).statusCode).toBe(200);
  expect(mockNotifications.subscribe).toHaveBeenCalledWith(expect.objectContaining({ id: 'bujjuluu' }), { endpoint: 'test' });
  await handler(http('/notifications/test', 'POST', { endpoint: 'test' }));
  expect(mockNotifications.test).toHaveBeenCalledWith(expect.objectContaining({ id: 'bujjuluu' }), 'test');
});
test('Function URL JSON cannot impersonate a scheduled invocation or an IAM-only runtime probe', async () => {
  const spoof = { job: 'reminder-health', source: 'aws.events', 'detail-type': 'Scheduled Event', resources: ['arn:aws:events:us-east-1:123:rule/mana-muchatlu-nightly-reminder'] };
  expect((await handler(http('/', 'POST', spoof, false))).statusCode).toBe(401);
  expect(mockNotifications.nightly).not.toHaveBeenCalled(); expect(mockNotifications.config).not.toHaveBeenCalled();
});
test('only the named daily EventBridge rule reaches the reminder job', async () => {
  const event = { source: 'aws.events', 'detail-type': 'Scheduled Event', resources: ['arn:aws:events:us-east-1:123:rule/mana-muchatlu-nightly-reminder'], time: '2026-11-10T16:00:00Z' };
  await handler(event); expect(mockNotifications.nightly).toHaveBeenCalledWith(event);
  jest.clearAllMocks();
  await handler({ ...event, resources: ['arn:aws:events:us-east-1:123:rule/unrelated-rule'] });
  expect(mockNotifications.nightly).not.toHaveBeenCalled();
});
