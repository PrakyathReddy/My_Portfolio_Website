/* Device opt-in. Notification permission is requested only inside the user's tap. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ManaReminders = factory();
})(typeof window !== 'undefined' ? window : this, function () {
  'use strict';
  function create(options) {
    const request = options.request, notify = options.notify || function () {};
    const win = options.window || window, doc = win.document;
    const $ = id => doc.getElementById(id);
    const preferenceKey = 'mana.reminders.enabled';
    let signedIn = false, generation = 0, busy = false, enabled = false;
    let config = null, registration = null, subscription = null, mode = 'off', message = '';
    const supported = () => Boolean(win.Notification && win.PushManager && win.navigator.serviceWorker);
    function preference(value) {
      try {
        if (value !== undefined) win.localStorage.setItem(preferenceKey, String(value));
        // A native subscription is itself evidence of prior consent if storage was cleared.
        return win.localStorage.getItem(preferenceKey) !== 'false';
      } catch (_) { return value !== false; }
    }
    function render() {
      if (!$('reminders-toggle')) return;
      const button = $('reminders-toggle');
      button.disabled = busy || mode === 'unsupported' || mode === 'blocked' || !signedIn;
      button.textContent = busy ? 'One moment…' : mode === 'error' ? 'Try again' : enabled ? 'Turn off reminders' : 'Enable reminders';
      button.setAttribute('aria-pressed', String(enabled));
      $('reminders-test').hidden = !enabled;
      $('reminders-test').disabled = busy;
      $('reminders-status').textContent = message || (enabled ? 'On for this phone. Daily 9:30 PM IST ♥' : 'Off on this phone.');
    }
    function registrationReady() {
      if (registration) return Promise.resolve(registration);
      let timer;
      return Promise.race([
        win.navigator.serviceWorker.ready,
        new Promise((_, reject) => { timer = win.setTimeout(() => reject(new Error('The journal is updating. Reopen it and try again.')), 15000); }),
      ]).finally(() => win.clearTimeout(timer)).then(value => { registration = value; return value; });
    }
    function keyBytes(value) {
      const raw = win.atob(value.replace(/-/g, '+').replace(/_/g, '/'));
      return Uint8Array.from(raw, ch => ch.charCodeAt(0));
    }
    function keyMatches(item) {
      if (!item?.options?.applicationServerKey) return true;
      const actual = new Uint8Array(item.options.applicationServerKey), expected = keyBytes(config.publicKey);
      return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
    }
    async function refresh() {
      if (!signedIn || busy) return;
      if (!supported()) {
        mode = 'unsupported'; message = 'On iPhone, open this journal from your Home Screen to enable reminders.'; render(); return;
      }
      if (win.Notification.permission === 'denied') {
        enabled = false; mode = 'blocked'; message = 'Notifications are blocked. Allow them in your phone’s Notifications settings, then reopen the journal.'; render(); return;
      }
      const serial = generation; busy = true; message = 'Checking this phone…'; render();
      try {
        const result = await Promise.all([request('/notifications/config'), registrationReady()]);
        if (serial !== generation || !signedIn) return;
        config = result[0]; registration = result[1];
        subscription = await registration.pushManager.getSubscription();
        if (serial !== generation || !signedIn) return;
        enabled = Boolean(subscription && keyMatches(subscription) && win.Notification.permission === 'granted' && preference());
        if (enabled) await request('/notifications/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
        if (serial !== generation) return;
        mode = enabled ? 'on' : 'off'; message = '';
      } catch (_) {
        if (serial !== generation) return;
        mode = 'error'; enabled = false; message = 'Couldn’t check reminders. Tap Try again.';
      } finally { if (serial === generation) { busy = false; render(); } }
    }
    async function enable() {
      if (!signedIn || busy || !config || !supported()) return;
      const serial = generation;
      // Keep this call before ANY await; iPhone requires a direct user gesture.
      let permission;
      try { permission = win.Notification.permission === 'default' ? win.Notification.requestPermission() : Promise.resolve(win.Notification.permission); }
      catch (_) { message = 'Open the Home Screen journal to allow notifications.'; render(); return; }
      busy = true; message = 'Turning on your nightly nudge…'; render();
      let created = false;
      try {
        const allowed = await permission;
        if (serial !== generation || !signedIn) return;
        if (allowed !== 'granted') {
          enabled = false; mode = allowed === 'denied' ? 'blocked' : 'off';
          message = allowed === 'denied' ? 'Notifications are blocked. Allow them in your phone’s Notifications settings.' : 'Reminders stay off until you allow notifications.';
          return;
        }
        // Persist the allowed opt-in before async setup, so closing the app mid-request is recoverable.
        preference(true);
        registration = await registrationReady();
        subscription = await registration.pushManager.getSubscription();
        if (subscription && !keyMatches(subscription)) {
          await request('/notifications/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } });
          await subscription.unsubscribe(); subscription = null;
        }
        if (serial !== generation || !signedIn) return;
        if (!subscription) {
          subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(config.publicKey) });
          created = true;
        }
        if (serial !== generation || !signedIn) { if (created) await subscription.unsubscribe(); return; }
        await request('/notifications/subscribe', { method: 'POST', body: { subscription: subscription.toJSON() } });
        if (serial !== generation) return;
        preference(true); enabled = true; mode = 'on'; message = ''; notify('Nightly nudges on ♥ 9:30 PM IST');
      } catch (_) {
        if (created && subscription) {
          try { await subscription.unsubscribe(); subscription = null; preference(false); } catch (_) {}
        }
        if (serial !== generation) return;
        enabled = false; mode = 'error'; message = 'Couldn’t enable reminders. Check your connection and try again.';
      } finally { if (serial === generation) { busy = false; render(); } }
    }
    async function disable() {
      if (!supported()) { preference(false); return; }
      busy = true; message = 'Turning off reminders…'; render();
      try {
        registration = await registrationReady();
        subscription = await registration.pushManager.getSubscription();
        if (subscription) {
          // Even if the server is offline, unsubscribing locally stops this phone's delivery.
          try { await request('/notifications/unsubscribe', { method: 'POST', body: { endpoint: subscription.endpoint } }); } catch (_) {}
          await subscription.unsubscribe();
        }
        preference(false); subscription = null; enabled = false; mode = 'off'; message = '';
      } catch (error) {
        message = 'Couldn’t turn reminders off. Please try again.'; throw error;
      } finally { busy = false; render(); }
    }
    async function sendTest() {
      if (!signedIn || !enabled || busy || !subscription) return;
      busy = true; render();
      try {
        await request('/notifications/test', { method: 'POST', body: { endpoint: subscription.endpoint } });
        notify('Test reminder sent ♥ Check your notifications.');
      } catch (error) { notify(error.message || 'Couldn’t send a test reminder.'); }
      finally { busy = false; render(); }
    }
    function bind() {
      $('reminders-toggle').addEventListener('click', () => {
        if (mode === 'error') refresh();
        else if (enabled) disable().catch(() => notify('Couldn’t turn reminders off. Please try again.'));
        else enable();
      });
      $('reminders-test').addEventListener('click', sendTest);
      render();
    }
    return { bind, refresh, disable, isBusy: () => busy,
      signedIn() { signedIn = true; generation++; config = null; refresh(); },
      signedOut() { signedIn = false; generation++; busy = false; enabled = false; config = null; message = ''; render(); } };
  }
  return { create };
});
