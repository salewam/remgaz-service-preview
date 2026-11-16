import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createHttpServer } from './http.mjs';
import { loadConfig } from './config.mjs';

const tag = '1234567890abcdef';

function sign(config, { user = { id: 987654321, first_name: 'Оператор', is_bot: false },
  authDate = Math.floor(Date.now() / 1000), signingToken = config.telegramBotToken } = {}) {
  const fields = { auth_date: String(authDate) };
  if (user !== null) fields.user = JSON.stringify(user);
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(signingToken).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

async function waitForLeads(base, headers, predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = await fetch(`${base}/api/admin/leads`, { headers });
    assert.equal(response.status, 200);
    const { leads } = await response.json();
    if (predicate(leads)) return leads;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Saved leads did not reach the expected delivery status');
}

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

test('without a configured chat HTTP persists leads, binds only authenticated operators and preserves CMS editing', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-cms-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadConfig({
    PUBLIC_ORIGIN: 'https://remgaz.example.test', TELEGRAM_BOT_TOKEN: '123456:local-http-test-token',
    LEAD_IP_HASH_SECRET: 'a'.repeat(32), LEAD_DB_PATH: join(dir, 'leads.sqlite')
  });
  let now = Date.now();
  config.now = () => now;
  const deliveries = [];
  config.fetch = async (url, options) => { deliveries.push(JSON.parse(options.body)); return Response.json({ ok: true }); };
  await mkdir(join(dir, 'admin'));
  await writeFile(join(dir, 'index.html'), '<h1>public</h1>');
  await writeFile(join(dir, 'admin/index.html'), '<h1>Управление сайтом</h1>');
  let server = createHttpServer(config, undefined, dir);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => server.close(resolve)));
  let base = `http://127.0.0.1:${server.address().port}`;
  const publicHeaders = { Origin: config.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'http-queued' };
  const data = { name: 'Заявка до входа', phone: '+7 (921) 234-56-78', object: 'Дом', location: 'Выборг',
    user: { id: 444 }, chat: { id: 555 }, id: 666, chat_id: 777, ip: '198.51.100.123' };
  const submit = () => fetch(`${base}/api/lead`, { method: 'POST', headers: publicHeaders, body: JSON.stringify(data) });

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

  const oversized = await new Promise((resolve, reject) => {
    const pending = request(`${base}/api/lead`, {
      method: 'POST', headers: { Origin: config.origin, 'Content-Type': 'application/json', 'Content-Length': '4097' }
    }, async response => {
      try {
        let body = '';
        for await (const chunk of response) body += chunk;
        resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(body) });
      } catch (error) { reject(error); }
    });
    pending.on('error', reject);
    pending.setTimeout(2_000, () => pending.destroy(new Error('Oversized request waited for the body')));
    pending.flushHeaders();
  });
  assert.equal(oversized.status, 413);
  assert.equal(oversized.headers.connection, 'close');
  assert.equal(oversized.body.ok, false);
  const preflight = await fetch(`${base}/api/lead`, {
    method: 'OPTIONS', headers: { Origin: config.origin, 'Access-Control-Request-Method': 'POST' }
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), config.origin);
  const accepted = await submit();
  assert.equal(accepted.status, 200);
  assert.deepEqual(await accepted.json(), { ok: true, delivery: 'queued' });
  assert.equal(deliveries.length, 0, 'Public user/chat/id fields must not bind an operator');
  const leadDb = new DatabaseSync(config.dbPath, { readOnly: true });
  try {
    const rows = leadDb.prepare('SELECT * FROM leads').all();
    assert.equal(rows.length, 1);
    for (const key of ['name', 'phone', 'object', 'location']) assert.equal(rows[0][key], data[key]);
    for (const value of ['127.0.0.1', data.ip, config.telegramBotToken, 'http-queued']) {
      assert.equal(JSON.stringify(rows).includes(value), false);
    }
  } finally { leadDb.close(); }

  for (const authorization of [null, 'tma invalid', `tma ${sign(config, { signingToken: 'wrong-token' })}`,
    `tma ${sign(config, { authDate: Math.floor(Date.now() / 1000) - 86_400 })}`,
    `tma ${sign(config, { user: { id: 555, is_bot: true } })}`,
    `tma ${sign(config, { user: null })}`, `tma ${sign(config, { user: { first_name: 'Без ID' } })}`]) {
    for (const path of ['/api/admin/content', '/api/admin/leads']) {
      const denied = await fetch(base + path, { headers: authorization === null ? {} : { Authorization: authorization } });
      assert.equal(denied.status, 401, path);
      assert.equal(denied.headers.get('cache-control'), 'no-store');
      const body = await denied.json();
      assert.equal(body.ok, false);
      assert.equal('leads' in body, false);
      assert.equal(JSON.stringify(body).includes(data.phone), false);
    }
  }
  assert.equal(deliveries.length, 0, 'Rejected authentication must not bind or flush');
  const botIdentity = await fetch(`${base}/api/admin/leads`, {
    headers: { Authorization: `tma ${sign(config, { user: { id: 123456 } })}` }
  });
  assert.equal(botIdentity.status, 200);
  const unbound = await botIdentity.json();
  assert.equal(unbound.leads.length, 1);
  assert.equal(unbound.leads[0].delivery, 'queued');
  assert.equal(deliveries.length, 0, 'The configured bot ID must not become its own operator');
  await new Promise(resolve => server.close(resolve));
  server = createHttpServer(config, undefined, dir);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await submit()).json(), { ok: true, delivery: 'queued' });
  assert.equal(deliveries.length, 0);

  const headers = { Authorization: `tma ${sign(config)}`, Origin: config.origin, 'Content-Type': 'application/json' };
  const admin = await fetch(`${base}/api/admin/content`, { headers });
  assert.equal(admin.status, 200);
  assert.deepEqual(await admin.json(), document);
  const leads = await waitForLeads(base, headers, rows => rows.length === 1 && rows[0].delivery === 'sent');
  assert.equal(deliveries.length, 1);
  assert.equal(String(deliveries[0].chat_id), '987654321');
  const inbox = await fetch(`${base}/api/admin/leads`, { headers });
  assert.equal(inbox.status, 200);
  assert.equal(inbox.headers.get('cache-control'), 'no-store');
  assert.equal(inbox.headers.get('access-control-allow-origin'), null);
  assert.deepEqual(await inbox.json(), { leads });
  assert.deepEqual(leads[0], { id: leads[0].id, createdAt: new Date(now).toISOString(),
    name: data.name, phone: data.phone, object: data.object, location: data.location, delivery: 'sent' });
  assert.deepEqual(await (await submit()).json(), { ok: true, delivery: 'sent' });
  assert.equal(deliveries.length, 1);
  const secondHeaders = { ...headers, Authorization: `tma ${sign(config, { user: { id: 111222333 } })}` };
  assert.equal((await fetch(`${base}/api/admin/leads`, { headers: secondHeaders })).status, 200);
  now += 30_000;
  const second = await fetch(`${base}/api/lead`, { method: 'POST', headers: { ...publicHeaders, 'Idempotency-Key': 'http-second' },
    body: JSON.stringify({ ...data, name: 'После входа' }) });
  assert.deepEqual(await second.json(), { ok: true, delivery: 'sent' });
  assert.equal(deliveries.length, 3);
  const secondDeliveries = deliveries.slice(1);
  assert.deepEqual(secondDeliveries.map(d => String(d.chat_id)).sort(), ['111222333', '987654321']);
  const listed = await (await fetch(`${base}/api/admin/leads`, { headers })).json();
  assert.deepEqual(listed.leads.map(row => row.name), ['После входа', data.name]);

  const saved = await fetch(`${base}/api/admin/price`, {
    method: 'PUT', headers, body: JSON.stringify({ revision: document.revision, gasPriceRub: 73.25 })
  });
  assert.equal(saved.status, 200);
  const priced = await saved.json();
  assert.equal(priced.gasPriceRub, 73.25);
  const project = { ...priced.projects[0], title: 'Портфолио после получения заявки' };
  const edited = await fetch(`${base}/api/admin/projects/${project.id}`, {
    method: 'PUT', headers, body: JSON.stringify({ revision: priced.revision, project })
  });
  assert.equal(edited.status, 200);
  const updated = await edited.json();
  assert.equal(updated.projects.find(item => item.id === project.id).title, project.title);
  const db = new DatabaseSync(config.contentDbPath, { readOnly: true });
  try {
    const persisted = JSON.parse(db.prepare('SELECT document FROM content_document WHERE id=1').get().document);
    assert.deepEqual(persisted, updated);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='leads'").get().count, 0);
  } finally { db.close(); }
});

test('authenticated leads listing binds once, stays responsive during delivery and preserves precise outcomes after restart', async t => {
  for (const [delivery, result] of [
    ['sent', () => Response.json({ ok: true })],
    ['rejected', () => Response.json({ ok: false })],
    ['uncertain', () => { throw new Error('Telegram connection lost'); }]
  ]) {
    await t.test(delivery, async sub => {
      const dir = await mkdtemp(join(tmpdir(), 'remgaz-lead-status-http-'));
      sub.after(() => rm(dir, { recursive: true, force: true }));
      const config = loadConfig({ PUBLIC_ORIGIN: 'https://remgaz.example.test',
        TELEGRAM_BOT_TOKEN: '123456:local-http-test-token', LEAD_IP_HASH_SECRET: 'a'.repeat(32),
        LEAD_DB_PATH: join(dir, 'leads.sqlite') });
      let release;
      const stalled = new Promise(resolve => { release = resolve; });
      const calls = [];
      config.fetch = async (url, options) => { calls.push(JSON.parse(options.body)); await stalled; return result(); };
      let server = createHttpServer(config);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      sub.after(() => { release(); return new Promise(resolve => server.close(resolve)); });
      let base = `http://127.0.0.1:${server.address().port}`;
      const publicHeaders = { Origin: config.origin, 'Content-Type': 'application/json', 'Idempotency-Key': 'one-attempt' };
      const body = JSON.stringify({ name: 'Проверка статуса', phone: '+7 (921) 234-56-78' });
      const submit = () => fetch(`${base}/api/lead`, { method: 'POST', headers: publicHeaders, body });
      const queued = await submit();
      assert.equal(queued.status, 200);
      assert.deepEqual(await queued.json(), { ok: true, delivery: 'queued' });
      assert.equal(calls.length, 0);
      const headers = { Authorization: `tma ${sign(config)}` };
      const [first, duplicate] = await Promise.all([1, 2].map(() => fetch(`${base}/api/admin/leads`, {
        headers, signal: AbortSignal.timeout(2_000)
      })));
      for (const response of [first, duplicate]) {
        assert.equal(response.status, 200);
        const { leads } = await response.json();
        assert.equal(leads.length, 1);
        assert.equal(leads[0].delivery, 'uncertain', 'An in-flight claim is not an unsent queue entry');
      }
      assert.equal(calls.length, 1);
      assert.equal(String(calls[0].chat_id), '987654321');
      const admin = await fetch(`${base}/api/admin/content`, { headers, signal: AbortSignal.timeout(2_000) });
      assert.equal(admin.status, 200, 'Portfolio editing must not wait for Telegram');
      assert.deepEqual(await (await submit()).json(), { ok: true, delivery: 'queued' });
      release();
      const settled = await waitForLeads(base, headers, rows => rows[0]?.delivery === delivery);
      if (delivery === 'uncertain') {
        // The public status is also uncertain while sending; wait for the durable terminal state.
        const db = new DatabaseSync(config.dbPath, { readOnly: true });
        try {
          for (let attempt = 0; attempt < 100 && db.prepare('SELECT delivery FROM leads').get().delivery === 'sending'; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 10));
          }
          assert.equal(db.prepare('SELECT delivery FROM leads').get().delivery, 'uncertain');
        } finally { db.close(); }
      }
      await new Promise(resolve => server.close(resolve));
      server = createHttpServer(config);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      base = `http://127.0.0.1:${server.address().port}`;
      const reopened = await fetch(`${base}/api/admin/leads`, { headers });
      assert.deepEqual(await reopened.json(), { leads: settled });
      const replay = await submit();
      assert.equal(replay.status, 200);
      assert.deepEqual(await replay.json(), { ok: true, delivery: delivery === 'sent' ? 'sent' : 'queued' });
      assert.equal(calls.length, 1, 'Login, replay and restart must never repeat an attempted delivery');
    });
  }
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
  const admin = await fetch(url.replace('/api/lead', '/api/admin/content'), {
    headers: { Authorization: `tma ${sign(config)}` }
  });
  assert.equal(admin.status, 200);
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
    assert.deepEqual(await response.json(), { ok: true, delivery: 'sent' });
  }
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].chat_id, config.telegramChatId);
  assert.match(deliveries[0].text, /Тест/);
});

test('content initialization failures preserve the original error and safely close an injected lead service', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-init-error-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = {
    origin: 'https://remgaz.example.test', telegramBotToken: 'local-http-test-token',
    dbPath: join(dir, 'leads.sqlite'), ipHashSecret: 'a'.repeat(32),
    contentDbPath: '/unused-content.sqlite', contentMediaDir: '/'
  };
  assert.throws(() => createHttpServer(config), /Media root must be a dedicated directory/);
  let closed = 0;
  assert.throws(() => createHttpServer(config, { close() { closed += 1; } }), /Media root must be a dedicated directory/);
  assert.equal(closed, 1);
});

test('CLI launched through a directory symlink starts the CMS without a lead recipient', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-symlink-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = join(dir, 'current');
  await symlink(fileURLToPath(new URL('../', import.meta.url)), current, 'dir');
  const reservation = createServer();
  reservation.listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, [join(current, 'server/http.mjs')], {
    cwd: dir,
    env: {
      PUBLIC_ORIGIN: origin, TELEGRAM_BOT_TOKEN: 'local-cli-test-token',
      LEAD_IP_HASH_SECRET: 'a'.repeat(32), LEAD_DB_PATH: join(dir, 'leads.sqlite'),
      CONTENT_DB_PATH: join(dir, 'content.sqlite'), CONTENT_MEDIA_DIR: join(dir, 'media'),
      HOST: '127.0.0.1', PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
  let stdout = '';
  let stderr = '';
  let startupTimeout;
  child.stderr.on('data', chunk => { stderr += chunk; });
  try {
    await new Promise((resolve, reject) => {
      startupTimeout = setTimeout(() => reject(new Error(`CLI did not start: ${stderr}`)), 5_000);
      child.once('error', reject);
      child.once('exit', code => reject(new Error(`CLI exited before listening (${code}): ${stderr}`)));
      child.stdout.on('data', chunk => {
        stdout += chunk;
        if (stdout.includes(`Listening on 127.0.0.1:${port}`)) resolve();
      });
    });
    clearTimeout(startupTimeout);
    const health = await fetch(`${origin}/healthz`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const content = await fetch(`${origin}/api/content`, { signal: AbortSignal.timeout(2_000) });
    assert.equal(content.status, 200);
    assert.ok((await content.json()).projects.length > 0);
    assert.equal((await fetch(`${origin}/api/admin/content`, { signal: AbortSignal.timeout(2_000) })).status, 401);
    const accepted = await fetch(`${origin}/api/lead`, {
      method: 'POST', signal: AbortSignal.timeout(2_000),
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'CLI заявка', phone: '+7 (921) 234-56-78' })
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(await accepted.json(), { ok: true, delivery: 'queued' });
    assert.equal((await fetch(`${origin}/api/admin/leads`, { signal: AbortSignal.timeout(2_000) })).status, 401);
  } finally {
    clearTimeout(startupTimeout);
    if (child.pid) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      const killTimeout = setTimeout(() => child.kill('SIGKILL'), 3_000);
      try { await exited; }
      finally { clearTimeout(killTimeout); }
    }
  }
  assert.equal(child.exitCode, 0, stderr);
});
