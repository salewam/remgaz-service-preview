import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createContentService } from './content.mjs';

const origin = 'https://remgaz.example';
const token = '123456:CONTENT_TEST_TOKEN_NOT_A_REAL_BOT_TOKEN';
const now = 1_800_000_000_000;
const admin = { id: 123456789, first_name: 'Администратор', is_bot: false };
const ids = ['home', 'park-hotel', 'spa', 'production', 'hotel', 'bar', 'grain'];
const categories = ['house', 'hotel', 'spa', 'production', 'seasonal', 'restaurant', 'agro'];
const MAX_JSON = 64 * 1024;
const MAX_MEDIA = 8 * 1024 * 1024;
// Real 1x1 images from https://developers.google.com/speed/webp/faq#in_your_own_javascript.
const webp = {
  lossy: Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64'),
  lossless: Buffer.from('UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==', 'base64'),
  alpha: Buffer.from('UklGRkoAAABXRUJQVlA4WAoAAAAQAAAAAAAAAAAAQUxQSAwAAAARBxAR/Q9ERP8DAABWUDggGAAAABQBAJ0BKgEAAQAAAP4AAA3AAP7mtQAAAA==', 'base64'),
  animation: Buffer.from('UklGRlIAAABXRUJQVlA4WAoAAAASAAAAAAAAAAAAQU5JTQYAAAD/////AABBTk1GJgAAAAAAAAAAAAAAAAAAAGQAAABWUDhMDQAAAC8AAAAQBxAREYiI/gcA', 'base64'),
};

function sign({ user = admin, authDate = now / 1000, signingToken = token } = {}) {
  const fields = { query_id: 'content-test-query', auth_date: String(authDate), user: JSON.stringify(user) };
  const check = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(signingToken).digest();
  const params = new URLSearchParams(fields);
  params.set('hash', createHmac('sha256', secret).update(check).digest('hex'));
  return params.toString();
}

function seedDocument() {
  return {
    revision: 1,
    gasPriceRub: 50,
    projects: ids.map((id, index) => {
      const photos = [1, 2, 3].map(n => ({ src: `assets/portfolio/${id}-${n}.webp`, alt: `Фото ${n}`, width: 1600, height: 1200 }));
      return {
        id, categoryKey: categories[index], title: `Проект ${id}`, loc: 'Ленинградская область',
        desc: 'Описание проекта', task: 'Задача\nВторая строка', work: 'Выполненные работы',
        cardDesc: 'Текст главной карточки', navTitle: `Кратко ${id}`, categorySummary: 'Подпись категории',
        tags: ['Котельная', 'Газ'], facts: [{ label: 'Мощность', value: '100 кВт' }],
        photos, coverPhoto: photos[1].src, published: true,
      };
    }),
  };
}

function draft(id = 'new-project') {
  return {
    id, categoryKey: null, title: '', loc: '', desc: '', task: '', work: '', tags: [], facts: [],
    photos: [], coverPhoto: '', published: false,
  };
}

function makeRequest({ method = 'GET', path = '/api/content', data, body = data === undefined ? undefined : JSON.stringify(data),
  authorization = `tma ${sign()}`, requestOrigin = origin,
  contentType = method === 'POST' ? 'image/webp' : 'application/json', headers = {} } = {}) {
  const h = new Headers(headers);
  if (authorization !== null) h.set('Authorization', authorization);
  if (requestOrigin !== null) h.set('Origin', requestOrigin);
  if (contentType !== null) h.set('Content-Type', contentType);
  return new Request(`${origin}${path}`, {
    method, headers: h,
    ...(method !== 'GET' && method !== 'HEAD' ? { body, ...(body instanceof ReadableStream ? { duplex: 'half' } : {}) } : {}),
  });
}

async function fixture(t, { defaultSeed = false, seed = seedDocument() } = {}) {
  t.mock.method(Date, 'now', () => now);
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-content-'));
  const seedPath = join(dir, 'seed.json');
  const config = {
    origin, telegramBotToken: token, adminIds: [String(admin.id)],
    contentDbPath: join(dir, 'db', 'content.sqlite'), contentMediaDir: join(dir, 'media'),
  };
  const opened = new Set();
  t.after(async () => {
    for (const service of opened) service.close();
    await rm(dir, { recursive: true, force: true });
  });
  await writeFile(seedPath, JSON.stringify(seed));
  function connect(options = defaultSeed ? {} : { seedPath }) {
    const service = createContentService(config, options);
    opened.add(service);
    return service;
  }
  let service = connect();
  async function raw(options = {}, target = service) { return target.handle(makeRequest(options)); }
  async function send(options = {}, target = service) {
    const response = await raw(options, target);
    return { status: response.status, body: await response.json(), headers: response.headers };
  }
  return {
    dir, config, seedPath, seed, raw, send, connect,
    handle(request) { return service.handle(request); },
    stop() { service.close(); },
    restart(options = { seedPath }) { service.close(); service = connect(options); },
    async document() { return (await send({ path: '/api/admin/content' })).body; },
    savePrice(revision, gasPriceRub, options = {}, target = service) {
      return send({ method: 'PUT', path: '/api/admin/price', data: { revision, gasPriceRub }, ...options }, target);
    },
    saveProject(revision, project, options = {}, target = service) {
      return send({ method: 'PUT', path: `/api/admin/projects/${project.id}`, data: { revision, project }, ...options }, target);
    },
    upload(body = webp.lossy, options = {}) { return send({ method: 'POST', path: '/api/admin/media', body, ...options }); },
  };
}

async function errorResponse(response, status) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['error', 'ok']);
  assert.equal(body.ok, false);
  assert.equal(typeof body.error, 'string');
  assert.equal(body.error.includes(token), false);
  assert.equal(body.error.includes(sign()), false);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  return body;
}

function streamOf(chunks) {
  let index = 0;
  const state = { reads: 0, cancelled: false };
  state.body = new ReadableStream({
    pull(controller) {
      state.reads += 1;
      if (index < chunks.length) controller.enqueue(chunks[index++]);
      else controller.close();
    },
    cancel() { state.cancelled = true; },
  }, { highWaterMark: 0 });
  return state;
}

function riff(chunks) {
  const parts = chunks.map(([kind, data]) => {
    const header = Buffer.alloc(8);
    header.write(kind, 0, 4, 'ascii');
    header.writeUInt32LE(data.length, 4);
    return Buffer.concat([header, data, ...(data.length & 1 ? [Buffer.from([0])] : [])]);
  });
  const payload = Buffer.concat([Buffer.from('WEBP'), ...parts]);
  const header = Buffer.alloc(8);
  header.write('RIFF', 0, 4, 'ascii');
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function modified(bytes, change) {
  const copy = Buffer.from(bytes);
  change(copy);
  return copy;
}

test('default import-relative seed exposes all seven original projects and read-only public CORS', async t => {
  const app = await fixture(t, { defaultSeed: true });
  const source = JSON.parse(await readFile(new URL('../content/site.json', import.meta.url), 'utf8'));
  const publicContent = await app.send({ authorization: null, requestOrigin: 'https://another.example' });
  assert.equal(publicContent.status, 200);
  assert.deepEqual(publicContent.body, source);
  assert.equal(publicContent.body.revision, 1);
  assert.equal(publicContent.body.gasPriceRub, 50);
  assert.deepEqual(publicContent.body.projects.map(project => project.id), ['park-hotel', 'spa', 'production', 'home', 'hotel', 'bar', 'grain']);
  assert.ok(publicContent.body.projects.every(project => project.published && project.photos.length > 0));
  assert.equal(publicContent.headers.get('Access-Control-Allow-Origin'), '*');
  assert.equal(publicContent.headers.get('Access-Control-Allow-Credentials'), null);
  assert.equal(publicContent.headers.get('Cache-Control'), 'no-cache');
  const privateContent = await app.send({ path: '/api/admin/content', requestOrigin: null });
  assert.deepEqual(privateContent.body, source);
  assert.equal(privateContent.headers.get('Cache-Control'), 'no-store');
  assert.equal(privateContent.headers.get('Access-Control-Allow-Origin'), null);
});

test('seed is applied once; price and complete project edits survive missing or changed release seed', async t => {
  const app = await fixture(t);
  const price = await app.savePrice(1, 52.37);
  assert.equal(price.status, 200);
  assert.equal(price.body.revision, 2);
  assert.deepEqual(price.body.projects, app.seed.projects);
  const project = structuredClone(price.body.projects[2]);
  project.title = 'Обновлённый комплекс';
  project.loc = 'Посёлок Новый';
  project.desc = 'Новое описание';
  project.task = 'Первая задача\nВторая задача';
  project.work = 'Обновлённые работы';
  project.cardDesc = 'Отдельный текст карточки';
  project.navTitle = 'Короткое название';
  project.categorySummary = 'Короткая подпись';
  project.tags = ['Монтаж'];
  project.facts = [{ label: 'Срок', value: '5 дней' }];
  project.photos.reverse();
  project.photos.splice(1, 1);
  project.coverPhoto = project.photos[1].src;
  const saved = await app.saveProject(2, project);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 3);
  assert.equal(saved.body.gasPriceRub, 52.37);
  assert.deepEqual(saved.body.projects.map(item => item.id), ids);
  assert.deepEqual(saved.body.projects[2], project);
  await writeFile(app.seedPath, '{not the original seed');
  app.restart();
  assert.deepEqual(await app.document(), saved.body);
  app.restart({ seedPath: join(app.dir, 'absent-release-seed.json') });
  assert.deepEqual(await app.document(), saved.body);
  assert.deepEqual((await app.send()).body, saved.body);
});

test('empty hidden drafts append, persist, filter out publicly and require title and photo before publishing', async t => {
  const app = await fixture(t);
  const project = draft();
  project.desc = 'Сначала сохраним описание, фотографию добавим позднее.';
  const created = await app.saveProject(1, project);
  assert.equal(created.status, 200);
  assert.equal(created.body.projects.length, 8);
  assert.deepEqual(created.body.projects.at(-1), project);
  const publicContent = await app.send({ authorization: null });
  assert.equal(publicContent.body.revision, 2);
  assert.deepEqual(publicContent.body.projects, app.seed.projects);
  app.restart();
  assert.deepEqual((await app.document()).projects.at(-1), project);
  assert.equal((await app.saveProject(2, { ...project, published: true })).status, 400);
  assert.equal((await app.saveProject(2, { ...project, title: 'Есть название', published: true })).status, 400);
  const photo = (await app.upload()).body;
  assert.equal((await app.saveProject(2, { ...project, photos: [photo], coverPhoto: photo.src, published: true })).status, 400);
  const ready = { ...project, title: 'Новый объект', photos: [photo], coverPhoto: photo.src, published: true };
  const published = await app.saveProject(2, ready);
  assert.equal(published.status, 200);
  assert.deepEqual((await app.send()).body.projects.at(-1), ready);
  const hidden = await app.saveProject(3, { ...app.seed.projects[0], published: false });
  assert.equal(hidden.status, 200);
  assert.equal(hidden.body.projects[0].published, false);
  assert.equal((await app.send()).body.projects.some(item => item.id === 'home'), false);
});

test('every admin route rejects absent, forged, expired and unauthorized Telegram identities without consuming bodies', async t => {
  const app = await fixture(t);
  const tampered = new URLSearchParams(sign());
  tampered.set('user', JSON.stringify({ ...admin, first_name: 'Подменено' }));
  const cases = [
    [null, 401], [`Bearer ${sign()}`, 401], ['tma invalid', 401], [`tma ${tampered}`, 401],
    [`tma ${sign({ signingToken: 'wrong-token' })}`, 401],
    [`tma ${sign({ authDate: now / 1000 - 3601 })}`, 401],
    [`tma ${sign({ user: { ...admin, id: admin.id + 1 } })}`, 403],
  ];
  for (const [authorization, status] of cases) {
    for (const [method, path] of [['GET', '/api/admin/content'], ['PUT', '/api/admin/price'], ['PUT', '/api/admin/projects/home'], ['POST', '/api/admin/media']]) {
      const stream = streamOf([Buffer.from('<html>not read</html>')]);
      const request = makeRequest({ method, path, authorization, body: stream.body });
      await errorResponse(await app.handle(request), status);
      assert.equal(request.bodyUsed, false);
      assert.equal(stream.reads, 0);
      await stream.body.cancel();
    }
  }
  assert.deepEqual(await app.document(), app.seed);
  assert.deepEqual(await readdir(app.config.contentMediaDir), []);
});

test('all writes require exact configured Origin before any body is read', async t => {
  const app = await fixture(t);
  for (const requestOrigin of [null, 'null', `${origin}/`, `${origin}.evil`, 'http://remgaz.example', 'https://other.example']) {
    for (const [method, path] of [['PUT', '/api/admin/price'], ['PUT', '/api/admin/projects/home'], ['POST', '/api/admin/media']]) {
      const stream = streamOf([Buffer.from('not read')]);
      const request = makeRequest({ method, path, requestOrigin, body: stream.body });
      await errorResponse(await app.handle(request), 403);
      assert.equal(request.bodyUsed, false);
      assert.equal(stream.reads, 0);
      await stream.body.cancel();
    }
  }
  assert.equal((await app.savePrice(1, 51)).status, 200);
});

test('stale revisions and simultaneous price/project writers are atomic across two SQLite connections', async t => {
  const app = await fixture(t);
  const peer = app.connect();
  const first = await app.savePrice(1, 51);
  const changedProject = { ...app.seed.projects[0], title: 'Конкурирующая правка' };
  assert.equal((await app.saveProject(1, changedProject)).status, 409);
  assert.equal((await app.savePrice(1, 99)).status, 409);
  assert.deepEqual(await app.document(), first.body);
  const responses = await Promise.all([
    app.savePrice(2, 55), app.saveProject(2, changedProject, {}, peer),
  ]);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 409]);
  const winner = responses.find(result => result.status === 200).body;
  assert.equal(winner.revision, 3);
  assert.deepEqual(await app.document(), winner);
  if (winner.gasPriceRub === 55) assert.deepEqual(winner.projects, first.body.projects);
  else {
    assert.equal(winner.gasPriceRub, 51);
    assert.deepEqual(winner.projects[0], changedProject);
    assert.deepEqual(winner.projects.slice(1), first.body.projects.slice(1));
  }
  app.restart();
  assert.deepEqual(await app.document(), winner);
});

test('upserts preserve position and category associations; invalid writes leave the whole document unchanged', async t => {
  const app = await fixture(t);
  const existing = app.seed.projects[0];
  assert.equal((await app.saveProject(1, { ...existing, categoryKey: null })).status, 400);
  assert.equal((await app.saveProject(1, { ...existing, categoryKey: 'hotel' })).status, 400);
  assert.equal((await app.saveProject(1, { ...draft(), categoryKey: 'house' })).status, 400);
  assert.equal((await app.saveProject(1, { ...existing, id: 'another-id' }, { path: '/api/admin/projects/home' })).status, 400);
  assert.deepEqual(await app.document(), app.seed);
  const updated = await app.saveProject(1, { ...existing, title: 'Сохранённое название' });
  assert.equal(updated.status, 200);
  assert.deepEqual(updated.body.projects.map(item => item.id), ids);
  assert.equal(updated.body.projects[0].coverPhoto, existing.photos[1].src);
  assert.equal((await app.saveProject(2, draft('second-new'))).status, 200);
  assert.equal((await app.document()).projects.at(-1).id, 'second-new');
});

test('price validation accepts whole kopecks without floating-point surprises and rejects wrong types', async t => {
  const app = await fixture(t);
  for (const value of [0, -1, 0.001, 50.999, '50', null, [], {}, { valueOf: null, toString: null }, 1e100]) {
    assert.equal((await app.savePrice(1, value)).status, 400, JSON.stringify(value));
    assert.deepEqual(await app.document(), app.seed);
  }
  for (const [index, value] of [0.01, 0.29, 19.99, 999.99].entries()) {
    const result = await app.savePrice(index + 1, value);
    assert.equal(result.status, 200);
    assert.equal(result.body.gasPriceRub, value);
    assert.equal(result.body.revision, index + 2);
  }
});

test('project validation enforces plain text, every field bound, data types and safe photo paths', async t => {
  const app = await fixture(t);
  const base = app.seed.projects[0];
  const changes = [
    project => { delete project.title; },
    project => { project.extra = 'unknown'; },
    project => { project.title = '<script>alert(1)</script>'; },
    project => { project.work = 'Текст\u0000'; },
    project => { project.title = []; },
    project => { project.published = 'true'; },
    project => { project.title = '   '; },
    project => { project.tags = Array(13).fill('Газ'); },
    project => { project.tags = ['x'.repeat(161)]; },
    project => { project.tags = [12]; },
    project => { project.facts = Array(17).fill({ label: 'A', value: 'B' }); },
    project => { project.facts = [{ label: 'x'.repeat(121), value: 'B' }]; },
    project => { project.facts = [{ label: 'A', value: 'x'.repeat(241) }]; },
    project => { project.facts = [{ label: 'A', value: 'B', link: 'extra' }]; },
    project => { project.facts = [null]; },
    project => { project.photos = Array(61).fill(base.photos[0]); },
    project => { project.photos = []; project.coverPhoto = ''; },
    project => { project.photos = {}; },
    project => { project.photos[0].width = 0; },
    project => { project.photos[0].height = 1.5; },
    project => { project.photos[0].width = '1600'; },
    project => { project.photos[0].alt = '<img src=x>'; },
    project => { project.photos[0].alt = 'x'.repeat(241); },
    project => { project.coverPhoto = 'assets/portfolio/not-in-gallery.webp'; },
    project => { project.coverPhoto = null; },
  ];
  for (const [key, limit] of Object.entries({ title: 200, loc: 240, desc: 2000, task: 8000, work: 12000, cardDesc: 2000, navTitle: 200, categorySummary: 240 })) {
    changes.push(project => { project[key] = 'x'.repeat(limit + 1); });
  }
  for (const src of [
    'https://evil.example/photo.webp', '//evil.example/photo.webp', 'javascript:alert(1)', 'data:image/webp;base64,abcd',
    'file:///etc/passwd', '/etc/passwd', 'assets/portfolio/../secret.webp', 'assets/portfolio/%2e%2e/secret.webp',
    'assets/portfolio/name.svg', 'assets/portfolio/name.webp?x=1', 'assets/portfolio/name.webp#x',
    'assets\\portfolio\\name.webp', `assets/portfolio/name\u0000.webp`, `/media/${'a'.repeat(64)}.webp`,
  ]) changes.push(project => { project.photos[0].src = src; });
  for (const change of changes) {
    const project = structuredClone(base);
    change(project);
    assert.equal((await app.saveProject(1, project)).status, 400);
    assert.deepEqual(await app.document(), app.seed);
  }
  for (const badRevision of [0, -1, 1.5, '1', null]) assert.equal((await app.savePrice(badRevision, 51)).status, 400);
  const atLimits = structuredClone(base);
  for (const [key, limit] of Object.entries({ title: 200, loc: 240, desc: 2000, task: 8000, work: 12000, cardDesc: 2000, navTitle: 200, categorySummary: 240 })) atLimits[key] = 'x'.repeat(limit);
  atLimits.tags = Array(12).fill('x'.repeat(160));
  atLimits.facts = Array(16).fill({ label: 'x'.repeat(120), value: 'x'.repeat(240) });
  atLimits.photos = Array(60).fill({ ...base.photos[0], alt: 'x'.repeat(240) });
  atLimits.coverPhoto = base.photos[0].src;
  assert.ok(Buffer.byteLength(JSON.stringify({ revision: 1, project: atLimits })) <= MAX_JSON);
  assert.equal((await app.saveProject(1, atLimits)).status, 200);
});

test('JSON reads are UTF-8 strict and capped at 64KiB while streaming, including a lying Content-Length', async t => {
  const app = await fixture(t);
  const exact = JSON.stringify({ revision: 1, gasPriceRub: 51 }).padEnd(MAX_JSON, ' ');
  assert.equal((await app.savePrice(1, 51, { body: exact })).status, 200);
  await errorResponse(await app.raw({ method: 'PUT', path: '/api/admin/price', body: `${exact} ` }), 413);
  const stream = streamOf([Buffer.alloc(MAX_JSON / 2, 32), Buffer.alloc(MAX_JSON / 2, 32), Buffer.from('x'), Buffer.from('unread')]);
  await errorResponse(await app.raw({ method: 'PUT', path: '/api/admin/price', body: stream.body, headers: { 'Content-Length': '1' } }), 413);
  assert.equal(stream.reads, 3);
  assert.equal(stream.cancelled, true);
  for (const body of ['{', 'null', '[]', '{"revision":2}', '{"revision":2,"gasPriceRub":60,"unknown":1}', Buffer.from([0xff, 0xfe])]) {
    await errorResponse(await app.raw({ method: 'PUT', path: '/api/admin/price', body }), 400);
  }
  await errorResponse(await app.raw({ method: 'PUT', path: '/api/admin/price', data: { revision: 2, gasPriceRub: 52 }, contentType: 'text/plain' }), 415);
  await errorResponse(await app.raw({ method: 'PUT', path: '/api/admin/price', body: '{}', headers: { 'Content-Length': '3' } }), 400);
  assert.equal((await app.document()).revision, 2);
  assert.equal((await app.document()).gasPriceRub, 51);
});

test('real lossy, lossless and alpha WebP uploads are hashed, registered, deduplicated and served by GET/HEAD', async t => {
  const app = await fixture(t);
  for (const bytes of [webp.lossy, webp.lossless, webp.alpha]) {
    const hash = createHash('sha256').update(bytes).digest('hex');
    const uploaded = await app.upload(bytes);
    assert.equal(uploaded.status, 200);
    assert.deepEqual(uploaded.body, { src: `/media/${hash}.webp`, alt: '', width: 1, height: 1 });
    const path = join(app.config.contentMediaDir, `${hash}.webp`);
    assert.deepEqual(await readFile(path), bytes);
    const before = await stat(path);
    assert.deepEqual((await app.upload(bytes)).body, uploaded.body);
    const after = await stat(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mtimeMs, before.mtimeMs);
    const image = await app.raw({ path: uploaded.body.src, authorization: null });
    assert.equal(image.status, 200);
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), bytes);
    assert.equal(image.headers.get('Content-Type'), 'image/webp');
    assert.equal(image.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.equal(image.headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
    assert.equal(image.headers.get('ETag'), `"${hash}"`);
    assert.equal(image.headers.get('Content-Length'), String(bytes.length));
    const head = await app.raw({ method: 'HEAD', path: uploaded.body.src, authorization: null });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
    assert.equal(head.headers.get('Content-Length'), String(bytes.length));
    assert.equal(head.headers.get('ETag'), image.headers.get('ETag'));
    for (const tag of [`"${hash}"`, `W/"${hash}"`, '*']) {
      const cached = await app.raw({ path: uploaded.body.src, headers: { 'If-None-Match': tag } });
      assert.equal(cached.status, 304);
      assert.equal(await cached.text(), '');
    }
  }
  assert.equal((await readdir(app.config.contentMediaDir)).length, 3);
  assert.deepEqual(await app.document(), app.seed);
  app.restart();
  const hash = createHash('sha256').update(webp.lossy).digest('hex');
  const persisted = await app.raw({ path: `/media/${hash}.webp`, authorization: null });
  assert.equal(persisted.status, 200);
  assert.deepEqual(Buffer.from(await persisted.arrayBuffer()), webp.lossy);
});

test('interrupted media writes leave only private temps and complete hash files remain recoverable after publication', async t => {
  for (const afterLink of [false, true]) {
    await t.test(afterLink ? 'crash after publishing before temp cleanup' : 'crash during partial write', async subtest => {
      const app = await fixture(subtest);
      const bytes = afterLink ? webp.lossless : webp.lossy;
      const filename = `${createHash('sha256').update(bytes).digest('hex')}.webp`;
      const target = join(app.config.contentMediaDir, filename);
      const exitCode = afterLink ? 74 : 73;
      // Fail only inside an isolated child; production has no fault-injection hooks.
      // The child exits without finally blocks, leaving real on-disk crash artifacts.
      const crash = afterLink
        ? 'fs.unlinkSync = () => process.exit(74);'
        : 'fs.writeFileSync = (fd, bytes) => { fs.writeSync(fd, bytes.subarray(0, 7)); process.exit(73); };';
      const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
        import fs from 'node:fs';
        import { syncBuiltinESMExports } from 'node:module';
        ${crash}
        syncBuiltinESMExports();
        Date.now = () => ${now};
        const { createContentService } = await import(${JSON.stringify(new URL('./content.mjs', import.meta.url).href)});
        const service = createContentService(${JSON.stringify(app.config)}, { seedPath: ${JSON.stringify(app.seedPath)} });
        const response = await service.handle(new Request(${JSON.stringify(`${origin}/api/admin/media`)}, {
          method: 'POST',
          headers: ${JSON.stringify({ Authorization: `tma ${sign()}`, Origin: origin, 'Content-Type': 'image/webp' })},
          body: Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'),
        }));
        service.close();
        process.stderr.write('Unexpected upload response: ' + response.status);
        process.exit(1);
      `], { encoding: 'utf8', timeout: 10_000 });
      assert.equal(child.error, undefined, child.error?.message);
      assert.equal(child.status, exitCode, child.stderr);
      const files = await readdir(app.config.contentMediaDir);
      const privateTemps = files.filter(name => name !== filename);
      assert.equal(privateTemps.length, 1);
      assert.equal(files.length, afterLink ? 2 : 1);
      const temporary = privateTemps[0];
      assert.deepEqual(await readFile(join(app.config.contentMediaDir, temporary)), afterLink ? bytes : bytes.subarray(0, 7));
      if (afterLink) {
        assert.deepEqual(await readFile(target), bytes);
        assert.equal((await stat(target)).nlink, 2);
      } else {
        await assert.rejects(stat(target), { code: 'ENOENT' });
      }
      app.restart();
      await errorResponse(await app.raw({ path: `/media/${temporary}`, authorization: null }), 404);
      await errorResponse(await app.raw({ path: `/media/${filename}`, authorization: null }), 404);
      const saved = await app.upload(bytes);
      assert.equal(saved.status, 200);
      assert.equal(saved.body.src, `/media/${filename}`);
      assert.deepEqual(await readFile(target), bytes);
      const complete = await app.raw({ path: saved.body.src, authorization: null });
      assert.equal(complete.status, 200);
      assert.deepEqual(Buffer.from(await complete.arrayBuffer()), bytes);
      const before = await stat(target);
      assert.deepEqual((await app.upload(bytes)).body, saved.body);
      assert.equal((await stat(target)).ino, before.ino);
      assert.deepEqual((await readdir(app.config.contentMediaDir)).sort(), [filename, temporary].sort());
      assert.deepEqual(await readFile(join(app.config.contentMediaDir, temporary)), afterLink ? bytes : bytes.subarray(0, 7));
    });
  }
});

test('a failed directory fsync leaves a complete but unregistered file that a later upload can safely recover', async t => {
  const app = await fixture(t);
  const filename = `${createHash('sha256').update(webp.lossy).digest('hex')}.webp`;
  const child = spawnSync(process.execPath, ['--input-type=module', '--eval', `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    const realFsync = fs.fsyncSync;
    fs.fsyncSync = fd => {
      if (fs.fstatSync(fd).isDirectory()) throw new Error('Simulated directory flush failure');
      return realFsync(fd);
    };
    syncBuiltinESMExports();
    Date.now = () => ${now};
    const { createContentService } = await import(${JSON.stringify(new URL('./content.mjs', import.meta.url).href)});
    const service = createContentService(${JSON.stringify(app.config)}, { seedPath: ${JSON.stringify(app.seedPath)} });
    const response = await service.handle(new Request(${JSON.stringify(`${origin}/api/admin/media`)}, {
      method: 'POST',
      headers: ${JSON.stringify({ Authorization: `tma ${sign()}`, Origin: origin, 'Content-Type': 'image/webp' })},
      body: Buffer.from(${JSON.stringify(webp.lossy.toString('base64'))}, 'base64'),
    }));
    const media = await service.handle(new Request(${JSON.stringify(`${origin}/media/${filename}`)}));
    service.close();
    process.stdout.write(JSON.stringify({ uploadStatus: response.status, mediaStatus: media.status }));
  `], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { uploadStatus: 500, mediaStatus: 404 });
  assert.deepEqual(await readdir(app.config.contentMediaDir), [filename]);
  assert.deepEqual(await readFile(join(app.config.contentMediaDir, filename)), webp.lossy);
  await errorResponse(await app.raw({ path: `/media/${filename}`, authorization: null }), 404);
  assert.deepEqual(await app.document(), app.seed);
  const recovered = await app.upload();
  assert.equal(recovered.status, 200);
  const published = await app.raw({ path: recovered.body.src, authorization: null });
  assert.equal(published.status, 200);
  assert.deepEqual(Buffer.from(await published.arrayBuffer()), webp.lossy);
});

test('uploaded photo metadata cannot be forged and removing a project reference keeps original image bytes', async t => {
  const app = await fixture(t);
  const photo = (await app.upload()).body;
  const project = { ...draft(), title: 'Новый проект', photos: [photo], coverPhoto: photo.src, published: true };
  assert.equal((await app.saveProject(1, { ...project, photos: [{ ...photo, width: 2 }] })).status, 400);
  const saved = await app.saveProject(1, project);
  assert.equal(saved.status, 200);
  assert.deepEqual((await app.send()).body.projects.at(-1), project);
  assert.equal((await app.saveProject(2, { ...project, photos: [], coverPhoto: '', published: false })).status, 200);
  app.restart();
  assert.equal((await app.document()).projects.at(-1).photos.length, 0);
  const response = await app.raw({ path: photo.src, authorization: null });
  assert.equal(response.status, 200);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), webp.lossy);
  assert.deepEqual(await readFile(join(app.config.contentMediaDir, basename(photo.src))), webp.lossy);
});

test('uploads reject HTML/SVG, wrong MIME, animation and malformed, truncated or excessive WebP headers', async t => {
  const app = await fixture(t);
  for (const contentType of ['text/html', 'image/svg+xml', 'image/jpeg', 'application/octet-stream', null]) {
    assert.equal((await app.upload(webp.lossy, { contentType })).status, 415);
  }
  const lossyPayload = webp.lossy.subarray(20);
  const extended = Buffer.alloc(10);
  const invalidImages = [
    Buffer.from('<!doctype html><script>alert(1)</script>'), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
    webp.animation, webp.lossy.subarray(0, -1), Buffer.concat([webp.lossy, Buffer.from('extra')]),
    modified(webp.lossy, bytes => { bytes[0] |= 0x80; }),
    modified(webp.lossy, bytes => { bytes[12] |= 0x80; }),
    modified(webp.lossy, bytes => { bytes.writeUInt32LE(0xffffffff, 16); }),
    modified(webp.lossy, bytes => { bytes[23] = 0; }),
    modified(webp.lossy, bytes => { bytes[20] |= 1; }),
    modified(webp.lossy, bytes => { bytes[20] &= ~16; }),
    modified(webp.lossy, bytes => { bytes[20] |= 14; }),
    modified(webp.lossy, bytes => { bytes.writeUIntLE(0xfffff0, 20, 3); }),
    modified(webp.lossy, bytes => { bytes.writeUInt16LE(0, 26); }),
    modified(webp.lossy, bytes => { bytes.writeUInt16LE(2401, 26); }),
    modified(webp.lossy, bytes => { bytes.writeUInt16LE(2401, 28); }),
    modified(webp.lossy, bytes => { bytes.writeUInt16LE(0x4001, 26); }),
    modified(webp.lossless, bytes => { bytes[24] |= 0x20; }),
    modified(webp.lossless, bytes => { bytes[bytes.length - 1] = 1; }),
    riff([['VP8L', webp.lossless.subarray(20, 25)]]),
    riff([['VP8 ', lossyPayload.subarray(0, 10)]]),
    riff([['VP8 ', lossyPayload], ['VP8 ', lossyPayload]]),
    riff([['VP8X', extended]]),
    riff([['VP8X', modified(extended, bytes => { bytes[0] = 2; })], ['VP8 ', lossyPayload]]),
    riff([['VP8X', modified(extended, bytes => { bytes[1] = 1; })], ['VP8 ', lossyPayload]]),
    riff([['VP8X', modified(extended, bytes => { bytes[4] = 1; })], ['VP8 ', lossyPayload]]),
    riff([['VP8X', modified(extended, bytes => { bytes[0] = 32; })], ['VP8 ', lossyPayload]]),
    riff([['ALPH', Buffer.from([0, 255])], ['VP8 ', lossyPayload]]),
    riff([['VP8 ', lossyPayload], ['ANIM', Buffer.alloc(6)]]),
    riff([['VP8 ', lossyPayload], ['HTML', Buffer.from('<html>')]]),
  ];
  for (let length = 0; length < 26; length++) invalidImages.push(webp.lossy.subarray(0, length));
  for (const [index, bytes] of invalidImages.entries()) assert.equal((await app.upload(bytes)).status, 400, `invalid image ${index}`);
  assert.deepEqual(await readdir(app.config.contentMediaDir), []);
  assert.deepEqual(await app.document(), app.seed);
});

test('upload byte limit is enforced before parsing and while streaming without trusting Content-Length', async t => {
  const app = await fixture(t);
  const unread = streamOf([webp.lossy]);
  await errorResponse(await app.raw({ method: 'POST', path: '/api/admin/media', body: unread.body, headers: { 'Content-Length': String(MAX_MEDIA + 1) } }), 413);
  assert.equal(unread.reads, 0);
  await unread.body.cancel();
  const chunk = Buffer.alloc(64 * 1024);
  const stream = streamOf([...Array(128).fill(chunk), Buffer.from('x'), Buffer.from('unread')]);
  await errorResponse(await app.raw({ method: 'POST', path: '/api/admin/media', body: stream.body, headers: { 'Content-Length': '1' } }), 413);
  assert.equal(stream.reads, 129);
  assert.equal(stream.cancelled, true);
  assert.deepEqual(await readdir(app.config.contentMediaDir), []);
});

test('media routing never serves unregistered filenames, encoded traversal or arbitrary paths', async t => {
  const app = await fixture(t);
  const hash = createHash('sha256').update(webp.lossy).digest('hex');
  await writeFile(join(app.dir, 'secret.webp'), 'private secret');
  await writeFile(join(app.config.contentMediaDir, `${hash}.webp`), webp.lossy);
  for (const path of [
    `/media/${hash}.webp`, '/media/secret.webp', '/media/../secret.webp', '/media/%2e%2e/secret.webp',
    '/media/%2e%2e%2fsecret.webp', '/media/%252e%252e%252fsecret.webp', '/media/..%5csecret.webp',
    `/media/${hash}.webp%00`, `/media/${hash}.webp/../secret.webp`, `/media/${hash}.webp/extra`,
    `/media/${hash.toUpperCase()}.webp`, '/etc/passwd',
  ]) await errorResponse(await app.raw({ path, authorization: null }), 404);
  const uploaded = await app.upload();
  assert.equal(uploaded.status, 200);
  assert.equal((await app.raw({ path: uploaded.body.src })).status, 200);
});

test('symlinked or tampered registered files are not served and cannot be overwritten by dedup uploads', async t => {
  const app = await fixture(t);
  const uploaded = (await app.upload()).body;
  const path = join(app.config.contentMediaDir, basename(uploaded.src));
  const original = join(app.dir, 'original.webp');
  const secret = join(app.dir, 'secret');
  const secretBytes = Buffer.alloc(webp.lossy.length, 65);
  await writeFile(secret, secretBytes);
  await rename(path, original);
  await symlink(secret, path);
  await errorResponse(await app.raw({ path: uploaded.src }), 404);
  await errorResponse(await app.raw({ method: 'HEAD', path: uploaded.src }), 404);
  assert.equal((await app.upload()).status, 500);
  assert.deepEqual(await readFile(secret), secretBytes);
  assert.deepEqual(await readFile(original), webp.lossy);
  await rm(path);
  await writeFile(path, secretBytes);
  await errorResponse(await app.raw({ path: uploaded.src }), 404);
  assert.equal((await app.upload()).status, 500);
  assert.deepEqual(await readFile(path), secretBytes);
});

test('media root must be a real directory and replacement roots cannot escape the configured storage', async t => {
  const app = await fixture(t);
  assert.throws(() => createContentService({ ...app.config, contentMediaDir: '/' }, { seedPath: app.seedPath }), /dedicated directory/);
  const uploaded = (await app.upload()).body;
  const originalRoot = join(app.dir, 'original-media');
  const outside = join(app.dir, 'outside');
  await mkdir(outside);
  await rename(app.config.contentMediaDir, originalRoot);
  await symlink(outside, app.config.contentMediaDir);
  await errorResponse(await app.raw({ path: uploaded.src }), 404);
  assert.equal((await app.upload(webp.lossless)).status, 500);
  assert.deepEqual(await readdir(outside), []);
  assert.throws(() => createContentService(app.config, { seedPath: app.seedPath }), /real directory/);
  assert.deepEqual(await readFile(join(originalRoot, basename(uploaded.src))), webp.lossy);
});

test('nonempty or damaged databases are never reset from seed', async t => {
  const app = await fixture(t);
  app.stop();
  const db = new DatabaseSync(app.config.contentDbPath);
  db.exec('DELETE FROM content_document');
  db.close();
  assert.throws(() => createContentService(app.config, { seedPath: app.seedPath }), /refusing to reseed/);
  const inspect = new DatabaseSync(app.config.contentDbPath);
  assert.equal(inspect.prepare('SELECT COUNT(*) AS count FROM content_document').get().count, 0);
  inspect.close();
  const unrelatedPath = join(app.dir, 'unrelated.sqlite');
  const unrelated = new DatabaseSync(unrelatedPath);
  unrelated.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep me')");
  unrelated.close();
  assert.throws(() => createContentService({ ...app.config, contentDbPath: unrelatedPath }, { seedPath: app.seedPath }), /unexpected schema/);
  const untouched = new DatabaseSync(unrelatedPath);
  assert.equal(untouched.prepare('SELECT value FROM unrelated').get().value, 'keep me');
  assert.equal(untouched.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='content_document'").get().count, 0);
  untouched.close();
});

test('unsupported routes and methods cannot mutate content', async t => {
  const app = await fixture(t);
  for (const [method, path, allow] of [
    ['POST', '/api/content', 'GET'], ['PUT', '/api/admin/content', 'GET'],
    ['GET', '/api/admin/price', 'PUT'], ['DELETE', '/api/admin/projects/home', 'PUT'],
    ['GET', '/api/admin/media', 'POST'], ['PUT', `/media/${'a'.repeat(64)}.webp`, 'GET, HEAD'],
  ]) {
    const response = await app.raw({ method, path });
    await errorResponse(response, 405);
    assert.equal(response.headers.get('Allow'), allow);
  }
  await errorResponse(await app.raw({ path: '/api/admin/unknown' }), 404);
  assert.deepEqual(await app.document(), app.seed);
});
