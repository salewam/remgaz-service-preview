import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import { TelegramAuthError, verifyTelegramInitData } from './telegram-admin.mjs';

const token = '123456:TEST_ONLY_NOT_A_REAL_BOT_TOKEN';
const now = 1_800_000_000_000;
const admin = { id: 123456789, first_name: 'Иван Петров', username: 'remgaz_admin', is_bot: false };
const adminIds = [String(admin.id)];

function fields(changes = {}) {
  return { query_id: 'AAE_test_query', user: JSON.stringify(admin), auth_date: String(now / 1000), ...changes };
}

function sign(values = fields(), signingToken = token) {
  const checkString = Object.keys(values).sort().map(key => `${key}=${values[key]}`).join('\n');
  const key = createHmac('sha256', 'WebAppData').update(signingToken).digest();
  const hash = createHmac('sha256', key).update(checkString).digest('hex');
  const params = new URLSearchParams(values);
  params.append('hash', hash);
  return params.toString();
}

function verify(initData, ids = adminIds, options = {}) {
  return verifyTelegramInitData(initData, token, ids, { now, ...options });
}

function authError(status) {
  return error => {
    assert.ok(error instanceof TelegramAuthError);
    assert.equal(error.name, 'TelegramAuthError');
    assert.equal(error.status, status);
    assert.match(error.message, /[А-Яа-яЁё]/);
    assert.ok(error.message.length < 120);
    assert.equal(error.message.includes(token), false);
    assert.equal(error.message.includes(admin.first_name), false);
    return true;
  };
}

test('verifies decoded Cyrillic data, arbitrary fields and signature independently of query order', () => {
  const expected = { ...admin, first_name: 'Анна + Иван / Москва', last_name: 'Сервис = газ' };
  const params = new URLSearchParams(sign(fields({
    user: JSON.stringify(expected),
    signature: 'test_signature-_ABCD',
    start_param: 'заказ + доставка=сегодня',
    a0: 'after a',
    a: 'first'
  })));
  const reversed = new URLSearchParams([...params].reverse()).toString();
  assert.deepEqual(verify(reversed), expected);
  assert.deepEqual(verify(reversed, new Set(adminIds)), expected);
  assert.deepEqual(verify(reversed.replaceAll('+', '%20')), expected);
  assert.equal(typeof verify(reversed).id, 'number');
});

test('accepts uppercase hexadecimal hash without changing the signed data', () => {
  const params = new URLSearchParams(sign());
  params.set('hash', params.get('hash').toUpperCase());
  assert.deepEqual(verify(params.toString()), admin);
});

test('checks the numeric user id allowlist, not username or client-provided identity fields', () => {
  const unknown = sign(fields({ user: JSON.stringify({ ...admin, id: admin.id + 1 }), userId: String(admin.id) }));
  assert.throws(() => verify(unknown), authError(403));
  assert.throws(() => verify(sign(), []), authError(403));
  assert.throws(() => verify(sign(), new Set([admin.id])), authError(403));
  assert.throws(() => verifyTelegramInitData(sign(), token, undefined, { now }), authError(403));
  assert.throws(() => verify(sign(), ['-100123456789']), authError(403));
  const renamed = { ...admin, username: 'another_username' };
  assert.deepEqual(verify(sign(fields({ user: JSON.stringify(renamed) }))), renamed);
});

test('rejects modifications to every signed field, including third-party signature and unknown fields', () => {
  const original = sign(fields({ signature: 'signed_signature', custom: 'исходное значение' }));
  for (const key of ['query_id', 'auth_date', 'user', 'signature', 'custom']) {
    const changed = new URLSearchParams(original);
    changed.set(key, `${changed.get(key)}changed`);
    assert.throws(() => verify(changed.toString()), authError(401));
    const removed = new URLSearchParams(original);
    removed.delete(key);
    assert.throws(() => verify(removed.toString()), authError(401));
  }
  assert.throws(() => verify(`${original}&extra=unsigned`), authError(401));
  assert.throws(() => verify(sign(fields(), '654321:OTHER_TEST_TOKEN')), authError(401));
  for (const missingToken of [undefined, null, '', 123]) {
    assert.throws(() => verifyTelegramInitData(original, missingToken, adminIds, { now }), authError(401));
  }
});

test('checks authenticity before reporting a missing administrator permission', () => {
  const params = new URLSearchParams(sign());
  params.set('user', JSON.stringify({ ...admin, id: admin.id + 1 }));
  assert.throws(() => verify(params.toString()), authError(401));
  assert.throws(() => verify(sign(fields({ auth_date: String(now / 1000 - 3601) })), []), authError(401));
});

test('rejects missing or non-hex hashes without exposing input data', () => {
  for (const hash of [null, '', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '0'.repeat(64), `${'a'.repeat(64)}\n`]) {
    const params = new URLSearchParams(sign());
    if (hash === null) params.delete('hash');
    else params.set('hash', hash);
    assert.throws(() => verify(params.toString()), authError(401));
  }
});

test('rejects duplicate decoded keys even when their values are identical', () => {
  const original = sign(fields({ custom: 'value' }));
  const params = new URLSearchParams(original);
  for (const key of ['hash', 'auth_date', 'user', 'custom']) {
    assert.throws(() => verify(`${original}&${key}=${encodeURIComponent(params.get(key))}`), authError(401));
  }
  assert.throws(() => verify(`${original}&%75ser=${encodeURIComponent(params.get('user'))}`), authError(401));
});

test('limits raw initData to 8192 characters and rejects absent or non-string input', () => {
  for (const value of [undefined, null, '', false, 42, {}, new URLSearchParams(sign()), 'x'.repeat(8193)]) {
    assert.throws(() => verify(value), authError(401));
  }
  const emptyPaddingLength = sign(fields({ padding: '' })).length;
  const atLimit = sign(fields({ padding: 'x'.repeat(8192 - emptyPaddingLength) }));
  assert.equal(atLimit.length, 8192);
  assert.deepEqual(verify(atLimit), admin);
  const overLimit = sign(fields({ padding: 'x'.repeat(8193 - emptyPaddingLength) }));
  assert.throws(() => verify(overLimit), authError(401));
});

test('enforces one-hour age and thirty-second future tolerance at exact boundaries', () => {
  for (const offset of [-3600, 0, 30]) {
    assert.deepEqual(verify(sign(fields({ auth_date: String(now / 1000 + offset) }))), admin);
  }
  for (const offset of [-3601, 31]) {
    assert.throws(() => verify(sign(fields({ auth_date: String(now / 1000 + offset) }))), authError(401));
  }
  const atLimit = sign(fields({ auth_date: String(now / 1000 - 3600) }));
  assert.throws(() => verify(atLimit, adminIds, { now: now + 1 }), authError(401));
  assert.deepEqual(verify(sign(fields({ auth_date: String(now / 1000 - 60) })), adminIds, { maxAgeSeconds: 60 }), admin);
  assert.throws(() => verify(sign(fields({ auth_date: String(now / 1000 - 61) })), adminIds, { maxAgeSeconds: 60 }), authError(401));
});

test('uses the current time and default lifetime when options are omitted', t => {
  t.mock.method(Date, 'now', () => now);
  assert.deepEqual(verifyTelegramInitData(sign(), token, adminIds), admin);
  assert.throws(() => verifyTelegramInitData(sign(fields({ auth_date: String(now / 1000 - 3601) })), token, adminIds), authError(401));
});

test('requires canonical integer auth_date and rejects invalid clock or lifetime settings', () => {
  for (const authDate of ['', '1800000000.0', '1.8e9', '+1800000000', '-1', '01800000000', ' 1800000000', '1800000000\n', '9007199254740992', 'Infinity']) {
    assert.throws(() => verify(sign(fields({ auth_date: authDate }))), authError(401));
  }
  assert.throws(() => verify(sign({ user: JSON.stringify(admin) })), authError(401));
  for (const options of [{ now: NaN }, { now: Infinity }, { now: -1 }, { maxAgeSeconds: -1 }, { maxAgeSeconds: 1.5 }, { maxAgeSeconds: Infinity }]) {
    assert.throws(() => verify(sign(), adminIds, options), authError(401));
  }
});

test('rejects malformed signed user data, unsafe ids and bots', () => {
  const malformedUsers = [
    '', '{', 'null', '[]', '"user"', 'false', '{}',
    ...['123456789', 0, -1, 1.5, 9007199254740992, null].map(id => JSON.stringify({ ...admin, id })),
    ...[true, 'false', 0, null].map(is_bot => JSON.stringify({ ...admin, is_bot }))
  ];
  for (const user of malformedUsers) {
    assert.throws(() => verify(sign(fields({ user }))), authError(401));
  }
  assert.throws(() => verify(sign({ auth_date: String(now / 1000) })), authError(401));
});

test('accepts an omitted is_bot flag and safe positive Telegram ids without coercion', () => {
  const user = { id: Number.MAX_SAFE_INTEGER, first_name: 'Администратор' };
  assert.deepEqual(verify(sign(fields({ user: JSON.stringify(user) })), [String(user.id)]), user);
});
