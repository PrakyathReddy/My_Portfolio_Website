/** @jest-environment jsdom */
const { create } = require('../web/reminders');
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
let client, request, permission, manager, sub, notify;
beforeEach(() => {
  document.body.innerHTML = '<button id="reminders-toggle"></button><button id="reminders-test" hidden></button><p id="reminders-status"></p>';
  localStorage.clear();
  const key = 'B' + 'A'.repeat(86);
  let current = null;
  sub = { endpoint: 'https://web.push.apple.com/test', toJSON: () => ({ endpoint: sub.endpoint, keys: { auth: 'test-auth', p256dh: 'test-public-key' } }),
    unsubscribe: jest.fn(async () => { current = null; return true; }) };
  manager = { getSubscription: jest.fn(async () => current), subscribe: jest.fn(async () => { current = sub; return sub; }) };
  permission = { permission: 'default', requestPermission: jest.fn(async () => { permission.permission = 'granted'; return 'granted'; }) };
  Object.defineProperty(window, 'Notification', { configurable: true, value: permission });
  Object.defineProperty(window, 'PushManager', { configurable: true, value: function () {} });
  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve({ pushManager: manager }) } });
  request = jest.fn(async route => route === '/notifications/config' ? { publicKey: key, schedule: { time: '21:30', timeZone: 'Asia/Kolkata' } } : { enabled: true });
  notify = jest.fn(); client = create({ window, request, notify }); client.bind();
});
test('opening the app never requests permission; the Enable tap requests it synchronously and registers only after consent', async () => {
  client.signedIn(); await flush();
  expect(permission.requestPermission).not.toHaveBeenCalled(); expect(manager.subscribe).not.toHaveBeenCalled();
  document.getElementById('reminders-toggle').click();
  expect(permission.requestPermission).toHaveBeenCalledTimes(1); // Before yielding, so the iPhone user gesture survives.
  await flush();
  expect(manager.subscribe).toHaveBeenCalledWith(expect.objectContaining({ userVisibleOnly: true }));
  expect(request).toHaveBeenCalledWith('/notifications/subscribe', expect.objectContaining({ method: 'POST' }));
  expect(localStorage.getItem('mana.reminders.enabled')).toBe('true');
  expect(document.getElementById('reminders-status').textContent).toContain('9:30 PM IST');
  document.getElementById('reminders-test').click(); await flush();
  expect(request).toHaveBeenCalledWith('/notifications/test', { method: 'POST', body: { endpoint: sub.endpoint } });
  document.getElementById('reminders-toggle').click(); await flush();
  expect(request).toHaveBeenCalledWith('/notifications/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
  expect(sub.unsubscribe).toHaveBeenCalled(); expect(localStorage.getItem('mana.reminders.enabled')).toBe('false');
});
test('denied permissions and unsupported browsers give instructions without a surprise permission prompt', async () => {
  permission.permission = 'denied'; client.signedIn(); await flush();
  expect(document.getElementById('reminders-toggle').disabled).toBe(true);
  expect(document.getElementById('reminders-status').textContent).toContain('Notifications settings');
  expect(permission.requestPermission).not.toHaveBeenCalled();
  Object.defineProperty(window, 'PushManager', { configurable: true, value: undefined });
  permission.permission = 'default'; client.signedIn(); await flush();
  expect(document.getElementById('reminders-status').textContent).toContain('Home Screen');
  expect(manager.subscribe).not.toHaveBeenCalled();
});
test('existing enabled subscriptions are renewed for the signed-in account without requesting permission again', async () => {
  permission.permission = 'granted'; localStorage.setItem('mana.reminders.enabled', 'true');
  manager.getSubscription.mockResolvedValue(sub);
  client.signedIn(); await flush();
  expect(request).toHaveBeenCalledWith('/notifications/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
  expect(permission.requestPermission).not.toHaveBeenCalled(); expect(manager.subscribe).not.toHaveBeenCalled();
  expect(document.getElementById('reminders-toggle').textContent).toBe('Turn off reminders');
});
test('a rejected or dismissed permission request never subscribes the device', async () => {
  permission.requestPermission.mockResolvedValue('default'); client.signedIn(); await flush();
  document.getElementById('reminders-toggle').click(); await flush();
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([route]) => route === '/notifications/subscribe')).toBe(false);
});
test('failed server registration rolls back a new browser subscription', async () => {
  const normal = request.getMockImplementation();
  request.mockImplementation(async (...args) => { if (args[0] === '/notifications/subscribe') throw new Error('offline'); return normal(...args); });
  client.signedIn(); await flush(); document.getElementById('reminders-toggle').click(); await flush();
  expect(sub.unsubscribe).toHaveBeenCalled();
  expect(localStorage.getItem('mana.reminders.enabled')).not.toBe('true');
  expect(document.getElementById('reminders-toggle').textContent).toBe('Try again');
});
test('signing out while the permission prompt is pending cannot register a device for a stale session', async () => {
  let resolvePermission;
  permission.requestPermission.mockImplementation(() => new Promise(resolve => { resolvePermission = resolve; }));
  client.signedIn(); await flush(); document.getElementById('reminders-toggle').click();
  client.signedOut(); resolvePermission('granted'); await flush();
  expect(manager.subscribe).not.toHaveBeenCalled();
  expect(request.mock.calls.some(([route]) => route === '/notifications/subscribe')).toBe(false);
});
