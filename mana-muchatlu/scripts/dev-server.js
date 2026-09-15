#!/usr/bin/env node
/**
 * Local development server.
 *
 *   node scripts/dev-server.js        then open http://localhost:4173
 *
 * Serves web/ and stands in for the API, reusing the real lib/auth.js and
 * lib/entries.js so that sign-in, validation and key construction behave
 * exactly as they do in Lambda. Only the DynamoDB calls are swapped for an
 * in-memory Map - that is the one layer worth faking, and the one layer the
 * unit tests already cover from the other side.
 *
 * Dev passphrases are printed at startup. They are not secrets and this server
 * binds to localhost only.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const auth = require('../api/lib/auth');
const entries = require('../api/lib/entries');

const PORT = Number(process.env.PORT || 4173);
const WEB_DIR = path.join(__dirname, '..', 'web');
const SESSION_SECRET = crypto.randomBytes(32).toString('base64');

// Fine to be this weak: the server binds to 127.0.0.1 and the data is a Map
// that dies with the process. The real passphrases live in SSM and are set by
// init-secrets.sh, which never sees this value.
const DEV_PASSPHRASE = process.env.MANA_DEV_PASSPHRASE || 'test';
const MEMBERS = auth.parseMembers(JSON.stringify([
  { id: 'prakyath', name: 'Prakyath', initials: 'P', accent: '#4a6fa5', passphraseHash: auth.hashPassphrase(DEV_PASSPHRASE) },
  { id: 'shivani', name: 'Shivani', initials: 'S', accent: '#c2847a', passphraseHash: auth.hashPassphrase(DEV_PASSPHRASE) },
]));

/** sortKey -> item. Mirrors the single-table layout, minus the network. */
const table = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers) {
  res.writeHead(status, Object.assign({ 'cache-control': 'no-store' }, headers || {}));
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), { 'content-type': MIME['.json'] });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // no reason for a bigger entry
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { resolve(null); }
    });
  });
}

function requireSession(req, res) {
  const claims = auth.verifyToken(auth.bearerFrom(req.headers), SESSION_SECRET);
  if (!claims) { sendJson(res, 401, { error: 'sign in first' }); return null; }
  const member = MEMBERS.find((m) => m.id === claims.sub);
  if (!member) { sendJson(res, 401, { error: 'sign in first' }); return null; }
  return member;
}

async function handleApi(req, res, url) {
  const p = url.pathname;

  if (req.method === 'OPTIONS') return send(res, 204, '');

  if (req.method === 'GET' && p === '/api/health') {
    return sendJson(res, 200, { ok: true, mode: 'dev' });
  }

  if (req.method === 'GET' && p === '/api/members') {
    return sendJson(res, 200, { members: auth.publicMembers(MEMBERS) });
  }

  if (req.method === 'POST' && p === '/api/auth/login') {
    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'body was not valid JSON' });

    const member = MEMBERS.find((m) => m.id === body.memberId);
    if (!member || !auth.verifyPassphrase(String(body.passphrase || ''), member.passphraseHash)) {
      return sendJson(res, 401, { error: 'that passphrase does not match' });
    }
    return sendJson(res, 200, {
      token: auth.signToken({ sub: member.id, name: member.name }, SESSION_SECRET),
      member: auth.publicMembers([member])[0],
      expiresIn: auth.TOKEN_TTL_SECONDS,
    });
  }

  if (req.method === 'GET' && p === '/api/entries') {
    if (!requireSession(req, res)) return undefined;
    const month = entries.normalizeMonth(url.searchParams.get('month'));
    if (!month) return sendJson(res, 400, { error: 'month must be supplied as YYYY-MM' });

    const prefix = entries.monthPrefix(month);
    const found = [...table.values()]
      .filter((item) => entries.entrySortKey(item.date, item.entryId).startsWith(prefix))
      .map(entries.toPublicEntry)
      .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : b.date.localeCompare(a.date)));

    return sendJson(res, 200, {
      month,
      entries: found,
      summary: entries.summarizeMonth(found),
    });
  }

  if (req.method === 'POST' && p === '/api/entries') {
    const member = requireSession(req, res);
    if (!member) return undefined;

    const body = await readBody(req);
    if (!body) return sendJson(res, 400, { error: 'body was not valid JSON' });

    const check = entries.validateEntry(body);
    if (!check.ok) return sendJson(res, 400, { error: check.errors[0] });

    const entryId = crypto.randomUUID();
    const item = entries.buildEntryItem({
      coupleId: 'mana', entryId, author: member.id, value: check.value, now: Date.now(),
    });
    table.set(item.sk, item);
    return sendJson(res, 201, { entry: entries.toPublicEntry(item) });
  }

  const match = /^\/api\/entries\/(\d{4}-\d{2}-\d{2})\/([A-Za-z0-9_-]{1,64})$/.exec(p);
  if (match) {
    const member = requireSession(req, res);
    if (!member) return undefined;
    const [, date, entryId] = match;
    const sk = entries.entrySortKey(date, entryId);

    if (req.method === 'DELETE') {
      if (!table.delete(sk)) return sendJson(res, 404, { error: 'that entry is gone' });
      return sendJson(res, 200, { deleted: true, entryId });
    }

    if (req.method === 'PATCH') {
      const existing = table.get(sk);
      if (!existing) return sendJson(res, 404, { error: 'that entry is gone' });

      const body = await readBody(req);
      if (!body) return sendJson(res, 400, { error: 'body was not valid JSON' });

      const check = entries.validateEntry({ ...body, date });
      if (!check.ok) return sendJson(res, 400, { error: check.errors[0] });

      const updated = {
        ...existing,
        title: check.value.title,
        body: check.value.body,
        mood: check.value.mood,
        updatedAt: Date.now(),
        lastEditedBy: member.id,
      };
      table.set(sk, updated);
      return sendJson(res, 200, { entry: entries.toPublicEntry(updated) });
    }
  }

  return sendJson(res, 404, { error: 'no such route' });
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';

  // config.js is generated at deploy time; in dev it points at this server.
  if (rel === '/config.js') {
    return send(res, 200, "window.MANA_CONFIG = { apiBase: '/api' };\n", {
      'content-type': MIME['.js'],
    });
  }

  const filePath = path.join(WEB_DIR, rel);
  // Contain path traversal: resolve, then confirm it is still inside web/.
  if (!path.resolve(filePath).startsWith(path.resolve(WEB_DIR))) {
    return send(res, 403, 'forbidden');
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      return fs.readFile(path.join(WEB_DIR, 'index.html'), (e2, shell) => {
        if (e2) return send(res, 404, 'not found');
        send(res, 200, shell, { 'content-type': MIME['.html'] });
      });
    }
    const type = MIME[path.extname(filePath)] || 'application/octet-stream';
    send(res, 200, data, { 'content-type': type });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (url.pathname.startsWith('/api/')) {
    handleApi(req, res, url).catch((err) => {
      console.error(err);
      sendJson(res, 500, { error: 'dev server blew up' });
    });
  } else {
    serveStatic(req, res, url);
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Mana Muchatlu dev server  ->  http://localhost:${PORT}`);
  console.log(`  members: ${MEMBERS.map((m) => m.id).join(', ')}`);
  console.log(`  dev passphrase for both: ${DEV_PASSPHRASE}\n`);
});
