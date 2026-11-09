/** @jest-environment jsdom */
const fs = require('fs');
const path = require('path');
const UI = require('../web/ui');
const entries = require('../api/lib/entries');
const html = fs.readFileSync(path.join(__dirname, '../web/index.html'), 'utf8');
const app = fs.readFileSync(path.join(__dirname, '../web/app.js'), 'utf8');
const $ = id => document.getElementById(id);
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const click = selector => document.querySelector(selector).click();
const input = (id, value) => { $(id).value = value; $(id).dispatchEvent(new Event('input', { bubbles: true })); };
const submit = () => $('entry-form').dispatchEvent(new Event('submit', { cancelable: true }));

test('real UI flow: required moods, placeholders, filters, immutable edit identity, media and draft restoration', async () => {
  document.documentElement.innerHTML = html.replace(/<!doctype html>/i, '').replace(/<\/?html[^>]*>/gi, '');
  Object.defineProperty(document, 'readyState', { configurable: true, value: 'complete' });
  const now = new Date();
  const date = [now.getFullYear(), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0')].join('-');
  const month = date.slice(0, 7);
  const members = [{ id: 'bangarammm', name: 'Prakyath' }, { id: 'bujjuluu', name: 'Shivani' }];
  const media = [{ key: 'mana/2026-09/keep.jpg', kind: 'image', url: 'https://example.test/photo', contentType: 'image/jpeg' },
    { key: 'mana/2026-09/keep.mp4', kind: 'audio', url: 'https://example.test/voice', contentType: 'audio/mp4', duration: 4 }];
  const legacy = { entryId: 'old-id', author: 'bujjuluu', date, title: 'Original memory', body: 'Original words', media, createdAt: 1, updatedAt: 1 };
  let records = [legacy, { entryId: 'other', author: 'bangarammm', date, title: 'His memory', body: 'His words', mood: 'calm', media: [] }];
  const original = JSON.stringify(records);
  const requests = [];
  let rejectUpload = false;
  window.URL.createObjectURL = jest.fn(() => 'blob:test-preview');
  window.URL.revokeObjectURL = jest.fn();
  const track = { stop: jest.fn() };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {
    getUserMedia: jest.fn(async () => ({ getTracks: () => [track] })),
  }});
  window.MediaRecorder = class {
    static isTypeSupported(type) { return type === 'audio/mp4'; }
    constructor() { this.mimeType = 'audio/mp4'; this.state = 'inactive'; this.listeners = {}; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    start() { this.state = 'recording'; }
    stop() {
      this.state = 'inactive';
      this.listeners.dataavailable({ data: new Blob(['voice'], { type: 'audio/mp4' }) });
      this.listeners.stop();
    }
  };
  window.confirm = jest.fn(() => true);
  window.MANA_CONFIG = { apiBase: '/api' }; window.ManaUI = UI;
  localStorage.setItem('mana.token', 'existing-session');
  localStorage.setItem('mana.member', JSON.stringify(members[1]));
  window.fetch = jest.fn(async (url, options = {}) => {
    const route = url.replace('/api', '');
    const payload = typeof options.body === 'string' ? JSON.parse(options.body) : null;
    requests.push({ route, method: options.method || 'GET', payload });
    let result = {};
    if (url === 'https://upload.test') return { status: rejectUpload ? 503 : 200, ok: !rejectUpload };
    if (route === '/media/presign') result = { key: 'mana/' + month + '/attachment-' + requests.length + (payload.contentType.startsWith('audio/') ? '.mp4' : '.png'), uploadUrl: 'https://upload.test', method: 'PUT' };
    else if (route === '/members') result = { members };
    else if (route.startsWith('/entries?')) {
      const wanted = new URLSearchParams(route.split('?')[1]).get('month');
      const visible = records.filter(r => r.date.startsWith(wanted));
      result = { entries: visible, summary: entries.summarizeMonth(visible) };
    } else if (route === '/auth/login') result = { token: 'new-session', member: members[0] };
    else if (options.method === 'POST' && route === '/entries') {
      const check = entries.validateEntry(payload, { hasMedia: payload.media.length > 0 });
      if (!check.ok) return { status: 400, ok: false, json: async () => ({ error: check.errors[0] }) };
      const saved = { ...payload, entryId: 'new-id', author: 'bujjuluu' }; records.unshift(saved); result = { entry: saved };
    } else if (options.method === 'PATCH') {
      const check = entries.validateEntry(payload, { hasMedia: payload.media.length > 0 });
      if (!check.ok) return { status: 400, ok: false, json: async () => ({ error: check.errors[0] }) };
      const target = records.find(r => route.endsWith(r.entryId));
      Object.assign(target, payload); result = { entry: target };
    }
    return { status: 200, ok: true, json: async () => result };
  });
  window.eval(app);
  await flush();
  expect($('app-view').hidden).toBe(false);
  expect($('today-page').hidden).toBe(false);
  expect($('entry-title').placeholder).toBe('Emaina sare, I’ll always love you, bujji ♥️🫂');
  expect($('entry-body').placeholder).toBe('idi mana safe space bujji… judgement-free. Emaina raskovachu');
  expect($('entry-body').value).toBe('');
  expect($('entry-title').value).toBe('');
  expect(localStorage.getItem('mana.token')).toBe('existing-session');
  expect(JSON.stringify(records)).toBe(original); // Opening the redesign never writes old records.
  expect($('save-btn').disabled).toBe(true);
  input('entry-body', 'Today draft stays here');
  submit(); await flush();
  expect(requests.filter(r => r.method === 'POST' && r.route === '/entries')).toHaveLength(0);
  expect($('save-btn').disabled).toBe(true);
  click('#mood-chips [data-mood="normal-day"]');
  expect($('save-btn').disabled).toBe(false);
  click('[data-view="memories"]');
  expect($('feed').querySelectorAll('.entry')).toHaveLength(2);
  click('#author-filters [aria-label="Shivani entries"]');
  expect($('feed').querySelectorAll('.entry')).toHaveLength(1);
  click('#feed .entry-edit');
  expect($('sheet-backdrop').hidden).toBe(false);
  expect($('entry-date').disabled).toBe(true);
  expect($('entry-date').value).toBe(date);
  expect($('entry-body').value).toBe('Original words');
  expect($('photo-strip').children).toHaveLength(2);
  expect($('save-btn').disabled).toBe(true); // Old mood-less record can be read; an edit needs a mood.
  input('entry-body', 'Our edited words');
  click('#more-moods');
  expect($('all-moods').children).toHaveLength(12);
  click('#all-moods [data-mood="missing-you"]');
  click('#mood-done');
  expect($('save-btn').disabled).toBe(false);
  submit(); await flush();
  const patch = requests.find(r => r.method === 'PATCH');
  expect(patch.route).toBe('/entries/' + date + '/old-id');
  expect(patch.payload.date).toBe(date);
  expect(patch.payload.media.map(m => m.key)).toEqual(media.map(m => m.key));
  expect(legacy.author).toBe('bujjuluu'); expect(legacy.entryId).toBe('old-id'); expect(legacy.createdAt).toBe(1);
  expect($('sheet-backdrop').hidden).toBe(true);
  click('[data-view="today"]');
  expect($('entry-body').value).toBe('Today draft stays here');
  expect($('mood-chips').querySelector('[aria-pressed="true"]').dataset.mood).toBe('normal-day');
  expect($('entry-id').value).toBe(''); expect($('entry-date').disabled).toBe(false);
  // Clearing a chosen mood immediately makes saving impossible again.
  click('#more-moods'); click('#clear-mood'); click('#mood-done');
  expect($('save-btn').disabled).toBe(true);
  click('#mood-chips [data-mood="perfect-day"]');
  submit(); await flush();
  const post = requests.find(r => r.method === 'POST' && r.route === '/entries');
  expect(post.payload.title).toBe(''); // Romantic prompts are placeholders, not stored text.
  expect(post.payload.body).toBe('Today draft stays here');
  expect(post.payload.mood).toBe('perfect-day');
  expect($('memories-page').hidden).toBe(false);
  expect($('entry-body').value).toBe(''); expect($('save-btn').disabled).toBe(true);
  click('[data-view="calendar"]');
  expect($('calendar-feed').querySelectorAll('.entry')).toHaveLength(3);
  expect($('calendar-grid').querySelector('[aria-pressed="true"] .day-dots').children).toHaveLength(2);
  // A later sign-in uses the other member's copy, without changing auth keys.
  click('#account-btn'); click('#signout-btn');
  expect(localStorage.getItem('mana.token')).toBeNull();
  click('#member-picker .member-btn'); input('passphrase', 'development-passphrase');
  $('signin-form').dispatchEvent(new Event('submit', { cancelable: true })); await flush();
  expect($('entry-body').placeholder).toBe('idi mana safe space Bangaaramm… judgement-free. Emaina raskovachu');
  expect($('entry-title').placeholder).toBe('Emaina sare, I’ll always love you, bangaaramm ♥️🫂');
  expect($('entry-body').value).toBe('');
  expect($('today-page').hidden).toBe(false);
  // A photo-only entry still needs a mood and must wait for its upload.
  click('#mood-chips [data-mood="normal-day"]');
  function pickPhoto() {
    Object.defineProperty($('photo-input'), 'files', { configurable: true,
      value: [new File(['photo'], 'test.png', { type: 'image/png' })] });
    $('photo-input').dispatchEvent(new Event('change'));
  }
  pickPhoto();
  expect($('save-btn').disabled).toBe(true);
  await flush(); expect($('save-btn').disabled).toBe(false);
  submit(); await flush();
  const photoPost = requests.filter(r => r.method === 'POST' && r.route === '/entries').pop();
  expect(photoPost.payload.body).toBe(''); expect(photoPost.payload.title).toBe('');
  expect(photoPost.payload.media).toHaveLength(1);
  expect(photoPost.payload.media[0].contentType).toBe('image/png');
  // A voice-only entry uses the real recorder/upload path; no device permission is needed in this test.
  click('[data-view="today"]'); click('#mood-chips [data-mood="sad"]');
  const clock = jest.spyOn(Date, 'now').mockReturnValue(10000);
  click('#record-btn'); await flush(); expect($('save-btn').disabled).toBe(true);
  clock.mockReturnValue(12000); click('#record-btn'); await flush(); clock.mockRestore();
  expect(track.stop).toHaveBeenCalled(); expect($('save-btn').disabled).toBe(false);
  submit(); await flush();
  const voicePost = requests.filter(r => r.method === 'POST' && r.route === '/entries').pop();
  expect(voicePost.payload.media[0]).toMatchObject({ contentType: 'audio/mp4', duration: 2 });
  expect(voicePost.payload.body).toBe(''); expect(voicePost.payload.mood).toBe('sad');
  // An upload failure cannot be silently dropped by Save.
  click('[data-view="today"]'); input('entry-body', 'Keep this text');
  click('#mood-chips [data-mood="normal-day"]'); rejectUpload = true; pickPhoto(); await flush();
  expect($('save-btn').disabled).toBe(true); expect($('photo-strip').querySelector('.is-failed')).not.toBeNull();
  click('#photo-strip .photo-remove'); expect($('save-btn').disabled).toBe(false);
  expect($('entry-body').value).toBe('Keep this text');
  expect($('memories-month-label').textContent).toBe(new Date(month + '-01T12:00:00').toLocaleDateString(undefined, { month: 'long', year: 'numeric' }));
});
