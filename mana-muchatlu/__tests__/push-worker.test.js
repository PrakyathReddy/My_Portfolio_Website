/** @jest-environment node */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
function worker() {
  const handlers = {};
  const self = { addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: jest.fn(async () => {}) }, location: { origin: 'https://journal.test' },
    clients: { matchAll: jest.fn(async () => []), openWindow: jest.fn(async () => {}) } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../web/sw.js'), 'utf8'), { self, URL });
  return { handlers, self };
}
test('a delivered reminder displays the encrypted payload as a visible notification with a deduplicating day tag', async () => {
  const w = worker(); let done;
  w.handlers.push({ data: { json: () => ({ kind: 'journal-reminder', title: 'Mana Muchatlu ♥', body: 'It’s journal time ♥', tag: 'mana-reminder-2026-11-10', url: 'https://untrusted.test' }) }, waitUntil: value => { done = value; } });
  await done;
  expect(w.self.registration.showNotification).toHaveBeenCalledWith('Mana Muchatlu ♥', expect.objectContaining({
    body: 'It’s journal time ♥', tag: 'mana-reminder-2026-11-10', renotify: false, data: { url: '/' },
  }));
});
test('malformed push data still produces a safe visible reminder', async () => {
  const w = worker(); let done;
  w.handlers.push({ data: { json: () => { throw new Error('bad JSON'); } }, waitUntil: value => { done = value; } }); await done;
  expect(w.self.registration.showNotification).toHaveBeenCalledWith('Mana Muchatlu ♥', expect.objectContaining({ body: 'It’s journal time ♥' }));
});
test('tapping the reminder opens only the journal, or focuses its existing draft without reloading it', async () => {
  const w = worker(); let done;
  const close = jest.fn();
  w.handlers.notificationclick({ notification: { close }, waitUntil: value => { done = value; } }); await done;
  expect(w.self.clients.openWindow).toHaveBeenCalledWith('/');
  const focus = jest.fn(async () => {});
  w.self.clients.matchAll.mockResolvedValue([{ url: 'https://journal.test/', focus }]);
  w.handlers.notificationclick({ notification: { close }, waitUntil: value => { done = value; } }); await done;
  expect(focus).toHaveBeenCalledTimes(1); expect(w.self.clients.openWindow).toHaveBeenCalledTimes(1);
});
