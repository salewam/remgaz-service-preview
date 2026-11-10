import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { test } from 'node:test';
import { createHttpServer } from './http.mjs';

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
