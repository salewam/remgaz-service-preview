import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { configureAdminBot } from './configure-admin-bot.mjs';

const token = '123456:TEST_ONLY_NOT_A_REAL_BOT_TOKEN';
const origin = 'https://remgaz.example.test';
const url = `${origin}/admin/`;
const bot = { id: 123456, is_bot: true, username: 'remgaz_admin_test_bot' };
const menu = { type: 'web_app', text: 'Управление сайтом', web_app: { url } };
const script = fileURLToPath(new URL('./configure-admin-bot.mjs', import.meta.url));
const privateDetail = `https://api.telegram.org/bot${token}/getMe private-user-data`;

function resultFor(method) {
  if (method === 'getMe') return bot;
  if (method === 'setChatMenuButton') return true;
  if (method === 'getChatMenuButton') return menu;
  throw new Error('Unexpected Telegram method');
}

function mockTelegram(respond = method => Response.json({ ok: true, result: resultFor(method) })) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (address, options) => {
      const endpoint = new URL(address);
      const method = endpoint.pathname.split('/').at(-1);
      const body = JSON.parse(options.body);
      calls.push({ endpoint, method, body, options });
      return respond(method, body, options);
    }
  };
}

function configure(stub, changes = {}) {
  return configureAdminBot({ botToken: token, origin, fetchImpl: stub.fetchImpl, ...changes });
}

function safeError(error) {
  assert.ok(error instanceof Error);
  assert.match(error.message, /[А-Яа-яЁё]/);
  assert.equal(error.stack.includes(token), false);
  assert.equal(error.stack.includes('private-user-data'), false);
  assert.equal(error.stack.includes('https://api.telegram.org'), false);
  assert.equal(error.cause, undefined);
  return true;
}

test('sets and verifies the default private-chat menu once without changing update delivery', async () => {
  const stub = mockTelegram();
  assert.deepEqual(await configure(stub), { username: bot.username, url });
  assert.deepEqual(stub.calls.map(call => call.method), ['getMe', 'setChatMenuButton', 'getChatMenuButton']);
  assert.deepEqual(stub.calls.map(call => call.body), [{}, { menu_button: menu }, {}]);
  for (const call of stub.calls) {
    assert.equal(call.endpoint.origin, 'https://api.telegram.org');
    assert.equal(call.endpoint.pathname, `/bot${token}/${call.method}`);
    assert.equal(call.endpoint.search, '');
    assert.equal(call.options.method, 'POST');
    assert.equal(call.options.headers['Content-Type'], 'application/json');
    assert.equal(call.options.redirect, 'error');
    assert.ok(call.options.signal instanceof AbortSignal);
  }
});


test('requires a canonical HTTPS origin with no credentials, path, query or fragment', async () => {
  for (const invalidOrigin of [
    undefined, null, '', 'http://remgaz.example.test', `${origin}/`, `${origin}/admin`,
    `${origin}?private=query`, `${origin}#fragment`, 'https://user:password@remgaz.example.test',
    ' https://remgaz.example.test', 'https://REMGaz.example.test', 'https://remgaz.example.test:443'
  ]) {
    const stub = mockTelegram();
    await assert.rejects(configure(stub, { origin: invalidOrigin }), safeError);
    assert.equal(stub.calls.length, 0);
  }
  const stub = mockTelegram(method => Response.json({
    ok: true,
    result: method === 'getChatMenuButton' ? { ...menu, web_app: { url: 'https://remgaz.example.test:8443/admin/' } } : resultFor(method)
  }));
  assert.equal((await configure(stub, { origin: 'https://remgaz.example.test:8443' })).url, 'https://remgaz.example.test:8443/admin/');
});

test('rejects malformed tokens and unavailable fetch without disclosing their values', async () => {
  for (const botToken of [undefined, null, '', 123, 'invalid', '123:secret/../../getUpdates', '123:secret?token=private', '123:secret\n']) {
    const stub = mockTelegram();
    await assert.rejects(configure(stub, { botToken }), safeError);
    assert.equal(stub.calls.length, 0);
  }
  const stub = mockTelegram();
  await assert.rejects(configure(stub, { fetchImpl: null }), safeError);
  assert.equal(stub.calls.length, 0);
});

test('rejects an invalid getMe identity before changing any menus', async () => {
  for (const identity of [
    null, {}, { ...bot, is_bot: false }, { ...bot, username: undefined },
    { ...bot, username: '@invalid' }, { ...bot, username: 'private\nuser' }, { ...bot, username: 'a'.repeat(33) }
  ]) {
    const stub = mockTelegram(() => Response.json({ ok: true, result: identity }));
    await assert.rejects(configure(stub), safeError);
    assert.deepEqual(stub.calls.map(call => call.method), ['getMe']);
  }
});

test('requires a literal true confirmation from setChatMenuButton', async () => {
  for (const result of [false, null, 1, 'true', {}]) {
    const stub = mockTelegram(method => Response.json({ ok: true, result: method === 'setChatMenuButton' ? result : resultFor(method) }));
    await assert.rejects(configure(stub), safeError);
    assert.deepEqual(stub.calls.map(call => call.method), ['getMe', 'setChatMenuButton']);
  }
});

test('checks the returned menu type, label and complete URL before claiming success', async () => {
  for (const button of [
    null, {}, { type: 'default' }, { ...menu, type: 'commands' }, { ...menu, text: 'Другой текст' },
    { ...menu, web_app: undefined }, { ...menu, web_app: { url: `${origin}/admin` } },
    { ...menu, web_app: { url: 'https://other.example.test/admin/' } }
  ]) {
    const stub = mockTelegram(method => Response.json({ ok: true, result: method === 'getChatMenuButton' ? button : resultFor(method) }));
    await assert.rejects(configure(stub), safeError);
    assert.deepEqual(stub.calls.map(call => call.method), ['getMe', 'setChatMenuButton', 'getChatMenuButton']);
  }
});

test('sanitizes transport, HTTP, Telegram and body failures at every API step and stops immediately', async () => {
  const methods = ['getMe', 'setChatMenuButton', 'getChatMenuButton'];
  const failures = [
    () => { throw new Error(privateDetail); },
    () => Response.json({ ok: false, description: privateDetail }, { status: 401 }),
    () => Response.json({ ok: false, description: privateDetail }),
    () => ({ ok: true, json: async () => { throw new Error(privateDetail); } })
  ];
  for (const [index, failingMethod] of methods.entries()) {
    for (const failure of failures) {
      const stub = mockTelegram(method => method === failingMethod ? failure() : Response.json({ ok: true, result: resultFor(method) }));
      await assert.rejects(configure(stub), safeError);
      assert.deepEqual(stub.calls.map(call => call.method), methods.slice(0, index + 1));
    }
  }
});

test('rejects invalid API envelopes even when HTTP succeeds', async () => {
  for (const payload of [null, [], {}, { ok: 1, result: bot }, { ok: true }, { result: bot }]) {
    const stub = mockTelegram(() => Response.json(payload));
    await assert.rejects(configure(stub), safeError);
    assert.equal(stub.calls.length, 1);
  }
  const stub = mockTelegram(() => new Response('not JSON: private-user-data', { status: 200 }));
  await assert.rejects(configure(stub), safeError);
  assert.equal(stub.calls.length, 1);
});

test('stops a request at ten seconds even when the transport ignores abort', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let signal;
  const operation = configure({ fetchImpl: (_address, options) => {
    signal = options.signal;
    return new Promise(() => {});
  } });
  const rejected = assert.rejects(operation, safeError);
  t.mock.timers.tick(9999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('includes response-body reading in the same ten-second deadline', { timeout: 1000 }, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const headers = Promise.withResolvers();
  const bodyStarted = Promise.withResolvers();
  let signal;
  const operation = configure({ fetchImpl: (_address, options) => {
    signal = options.signal;
    return headers.promise;
  } });
  const rejected = assert.rejects(operation, safeError);
  t.mock.timers.tick(6000);
  headers.resolve({ ok: true, json: () => {
    bodyStarted.resolve();
    return new Promise(() => {});
  } });
  await bodyStarted.promise;
  t.mock.timers.tick(3999);
  assert.equal(signal.aborted, false);
  t.mock.timers.tick(1);
  await rejected;
  assert.equal(signal.aborted, true);
});

test('clears completed request deadlines', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const stub = mockTelegram();
  await configure(stub);
  t.mock.timers.tick(10_000);
  assert.ok(stub.calls.every(call => !call.options.signal.aborted));
});

const cliEnvironment = {
  TELEGRAM_BOT_TOKEN: token,
  PUBLIC_ORIGIN: origin,
  LEAD_DB_PATH: '',
  LEAD_IP_HASH_SECRET: ''
};
const cliMock = `
  let menu;
  const methods = [];
  process.on('beforeExit', () => {
    if (JSON.stringify(methods) !== JSON.stringify(['getMe', 'setChatMenuButton', 'getChatMenuButton'])) throw new Error('Wrong Telegram method sequence');
  });
  globalThis.fetch = async (address, options) => {
    const endpoint = new URL(address);
    if (endpoint.origin !== 'https://api.telegram.org' || !endpoint.pathname.startsWith('/bot${token}/')) throw new Error('Wrong API host');
    const method = endpoint.pathname.split('/').at(-1);
    const body = JSON.parse(options.body);
    methods.push(method);
    const expectedKeys = method === 'setChatMenuButton' ? ['menu_button'] : [];
    if (JSON.stringify(Object.keys(body)) !== JSON.stringify(expectedKeys)) throw new Error('Expected default menu request');
    if (method === 'getMe') return Response.json({ ok: true, result: ${JSON.stringify(bot)} });
    if (method === 'setChatMenuButton') {
      if (JSON.stringify(body.menu_button) !== JSON.stringify(${JSON.stringify(menu)})) throw new Error('Wrong menu');
      menu = body.menu_button;
      return Response.json({ ok: true, result: true });
    }
    if (method === 'getChatMenuButton') return Response.json({ ok: true, result: menu });
    throw new Error('Forbidden Telegram method');
  };
`;

function runCli(changes = {}, preload = cliMock, entry = script) {
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(preload)}`, entry], {
    env: { ...cliEnvironment, ...changes }, encoding: 'utf8', timeout: 5000
  });
}

test('direct CLI requires no user or chat id and prints only username and public URL', () => {
  const result = runCli();
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { username: bot.username, url });
  assert.equal(result.stdout.includes(token), false);
});

test('CLI executes through a release directory symlink and configures the default menu without IDs', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remgaz-admin-bot-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const current = join(dir, 'current');
  await symlink(dirname(dirname(script)), current, 'dir');
  const result = runCli({}, cliMock, join(current, 'scripts', 'configure-admin-bot.mjs'));
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { username: bot.username, url });
  assert.equal(result.stdout.includes(token), false);
});


test('CLI failure output never includes tokens, request URLs or private Telegram responses', () => {
  const result = runCli({}, `globalThis.fetch = async () => Response.json({ ok: false, description: ${JSON.stringify(privateDetail)} });`);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /getMe/);
  assert.equal(result.stderr.includes(token), false);
  assert.equal(result.stderr.includes('private-user-data'), false);
  assert.equal(result.stderr.includes('https://api.telegram.org'), false);
});

test('importing the module performs no network request or CLI output', () => {
  const source = `
    let calls = 0;
    globalThis.fetch = async () => { calls++; throw new Error('Unexpected network call'); };
    const imported = await import(${JSON.stringify(pathToFileURL(script).href)});
    if (typeof imported.configureAdminBot !== 'function' || calls !== 0) throw new Error('Import has side effects');
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', source], {
    env: cliEnvironment, encoding: 'utf8', timeout: 5000
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr, '');
});
