import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { createHttpServer } from './http.mjs';
import { loadConfig } from './config.mjs';

const tag = '1234567890abcdef';

test('HTTP serves only public files, negotiates ETag and never caches HTML immutably', async t => {
  const dist = await mkdtemp(join(tmpdir(), 'remgaz-static-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  await mkdir(join(dist, 'assets', tag), { recursive: true });
  await writeFile(join(dist, 'index.html'), '<h1>public</h1>');
  await mkdir(join(dist, 'admin'));
  await mkdir(join(dist, 'content'));
  await writeFile(join(dist, 'admin/index.html'), '<h1>Управление сайтом</h1>');
  await writeFile(join(dist, 'content/site.json'), '{"revision":1,"gasPriceRub":50,"projects":[]}');
  await writeFile(join(dist, 'assets', tag, 'photo.webp'), 'photo bytes');
  await writeFile(join(dist, '.env'), 'secret');
  const service = { handle: () => new Response('{}'), close() {} };
  const server = createHttpServer({ origin: 'http://127.0.0.1', trustProxy: false }, service, dist);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const html = await fetch(base);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get('cache-control'), 'no-cache');
  assert.equal(await html.text(), '<h1>public</h1>');
  assert.equal((await fetch(`${base}/index.html`, { headers: { 'If-None-Match': html.headers.get('etag') } })).status, 304);
  assert.equal(html.headers.get('x-frame-options'), 'DENY');
  const redirect = await fetch(`${base}/admin`, { redirect: 'manual' });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.get('location'), '/admin/');
  const admin = await fetch(`${base}/admin/`);
  assert.equal(admin.status, 200);
  assert.equal(admin.headers.get('x-frame-options'), null, 'Telegram Web must be able to embed the admin UI');
  assert.match(admin.headers.get('content-security-policy'), /script-src 'self' https:\/\/telegram\.org/);
  assert.match(admin.headers.get('content-security-policy'), /frame-ancestors.*https:\/\/web\.telegram\.org/);
  assert.match(await admin.text(), /Управление сайтом/);
  const seed = await fetch(`${base}/content/site.json`);
  assert.equal(seed.status, 404, 'A static seed must not bypass the live published filter');
  assert.doesNotMatch(await seed.text(), /gasPriceRub/);
  const image = await fetch(`${base}/assets/${tag}/photo.webp`, { method: 'HEAD' });
  assert.equal(image.status, 200);
  assert.match(image.headers.get('cache-control'), /immutable/);
  assert.equal(image.headers.get('content-type'), 'image/webp');
  const missingImage = await fetch(`${base}/assets/${tag}/missing.webp`);
  assert.equal(missingImage.status, 404);
  assert.doesNotMatch(missingImage.headers.get('cache-control'), /immutable/);
  for (const path of ['/.env', '/server/lead.mjs', '/content/private.json', '/admin/server.env', '/assets/photo.webp', '/assets/%2e%2e/.env', '/%2e%2e/.env']) {
    assert.notEqual((await fetch(base + path)).status, 200, path);
  }
});

test('X-Real-IP is trusted only for a loopback peer and when explicitly enabled', async t => {
  for (const trustProxy of [false, true]) {
    let observed;
    const service = {
      handle: async (request, ip) => { observed = { ip, origin: request.headers.get('origin') }; return Response.json({ ok: true }); },
      close() {}
    };
    const server = createHttpServer({ origin: 'http://127.0.0.1', trustProxy }, service);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise(resolve => server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lead`, {
      method: 'POST', headers: { Origin: 'http://127.0.0.1', 'X-Real-IP': '192.0.2.18', 'X-Forwarded-For': '203.0.113.10', 'Content-Type': 'application/json' }, body: '{}'
    });
    assert.equal(response.status, 200);
    assert.deepEqual(observed, { ip: trustProxy ? '192.0.2.18' : '127.0.0.1', origin: 'http://127.0.0.1' });
    const oversized = await fetch(`http://127.0.0.1:${server.address().port}/api/lead`, {
      method: 'POST', headers: { Origin: 'http://127.0.0.1' }, body: 'x'.repeat(4_097)
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.headers.get('connection'), 'close');
  }
});

test('CMS runs with real SQLite and no lead recipient; disabled lead API never waits for a body or delivers', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-cms-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({
    PUBLIC_ORIGIN: 'https://remgaz.example.test', TELEGRAM_BOT_TOKEN: 'local-http-test-token',
    LEAD_IP_HASH_SECRET: 'a'.repeat(32), LEAD_DB_PATH: join(dir, 'leads.sqlite')
  });
  let deliveries = 0;
  config.fetch = async () => { deliveries += 1; throw new Error('Lead delivery must stay disabled'); };
  await mkdir(join(dir, 'admin'));
  await writeFile(join(dir, 'index.html'), '<h1>public</h1>');
  await writeFile(join(dir, 'admin/index.html'), '<h1>Управление сайтом</h1>');
  const server = createHttpServer(config, undefined, dir);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;

  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { ok: true });
  assert.equal(await (await fetch(base)).text(), '<h1>public</h1>');
  assert.match(await (await fetch(`${base}/admin/`)).text(), /Управление сайтом/);
  const content = await fetch(`${base}/api/content`);
  assert.equal(content.status, 200);
  const document = await content.json();
  assert.ok(document.projects.length > 0);
  assert.deepEqual(await (await fetch(`${base}/content/site.json`)).json(), document);
  assert.equal((await fetch(`${base}/api/admin/content`)).status, 401);

  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 987654321, first_name: 'Пользователь' }) };
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(config.telegramBotToken).digest();
  const initData = new URLSearchParams(fields);
  initData.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  const headers = { Authorization: `tma ${initData}`, Origin: config.origin, 'Content-Type': 'application/json' };
  const admin = await fetch(`${base}/api/admin/content`, { headers });
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), document);
  const saved = await fetch(`${base}/api/admin/price`, {
    method: 'PUT', headers, body: JSON.stringify({ revision: document.revision, gasPriceRub: 73.25 })
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).gasPriceRub, 73.25);
  const db = new DatabaseSync(config.contentDbPath, { readOnly: true });
  try {
    const persisted = JSON.parse(db.prepare('SELECT document FROM content_document WHERE id=1').get().document);
    assert.equal(persisted.gasPriceRub, 73.25);
  } finally { db.close(); }

  const disabled = await new Promise((resolve, reject) => {
    const pending = request(`${base}/api/lead`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': '4097' }
    }, async response => {
      try {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) });
      } catch (error) { reject(error); }
    });
    pending.on('error', reject);
    pending.setTimeout(2_000, () => pending.destroy(new Error('Disabled API waited for the request body')));
    pending.flushHeaders();
  });
  assert.equal(disabled.status, 503);
  assert.equal(disabled.headers.connection, 'close');
  assert.deepEqual(disabled.body, { ok: false, error: 'Приём заявок через сайт не настроен.' });
  assert.equal((await fetch(`${base}/api/lead`, { method: 'OPTIONS' })).status, 503);
  assert.equal(deliveries, 0);
  assert.throws(() => new DatabaseSync(config.dbPath, { readOnly: true }), /unable to open database file/);
});

test('configured recipient retains real lead delivery, validation, preflight and idempotency', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-lead-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({
    PUBLIC_ORIGIN: 'https://remgaz.example.test', TELEGRAM_BOT_TOKEN: 'local-http-test-token',
    TELEGRAM_CHAT_ID: '-100123456', LEAD_IP_HASH_SECRET: 'a'.repeat(32), LEAD_DB_PATH: join(dir, 'leads.sqlite')
  });
  const deliveries = [];
  config.fetch = async (url, options) => { deliveries.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
  const server = createHttpServer(config);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/api/lead`;
  const headers = { Origin: config.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-once' };
  const body = JSON.stringify({ name: 'Тест', phone: '+7 (921) 234-56-78' });
  assert.equal((await fetch(url, { method: 'OPTIONS', headers: { Origin: config.origin } })).status, 405);
  const preflight = await fetch(url, {
    method: 'OPTIONS', headers: { Origin: config.origin, 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), config.origin);
  assert.equal((await fetch(url)).status, 405);
  assert.equal((await fetch(url, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, Origin: 'https://other.example' }, body })).status, 403);
  assert.equal(deliveries.length, 0, 'Preflight and rejected requests must not deliver a lead');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, { method: 'POST', headers, body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chat_id, config.telegramChatId);
  assert.match(deliveries[0].text, /Тест/);
});

test('content initialization failures preserve the original error and safely close an injected lead service', () => {
  const config = {
    origin: 'https://remgaz.example.test', telegramBotToken: 'local-http-test-token',
    contentDbPath: '/unused-content.sqlite', contentMediaDir: '/'
  };
  assert.throws(() => createHttpServer(config), /Media root must be a dedicated directory/);
  let closed = 0;
  assert.throws(() => createHttpServer(config, { close() { closed += 1; } }), /Media root must be a dedicated directory/);
  assert.equal(closed, 1);
});
