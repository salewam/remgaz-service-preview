import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.mjs';

const valid = {
  PUBLIC_ORIGIN: 'https://remgaz.example.test',
  TELEGRAM_BOT_TOKEN: 'token',
  LEAD_IP_HASH_SECRET: 'a'.repeat(32),
  LEAD_DB_PATH: '/var/lib/remgaz/leads.sqlite'
};

test('CMS starts without a lead recipient and only binds to loopback', () => {
  assert.equal(loadConfig(valid).trustProxy, false);
  assert.equal(loadConfig({ ...valid, TRUST_PROXY: 'true' }).trustProxy, true);
  for (const change of [
    { PUBLIC_ORIGIN: 'https://remgaz.example.test/path' },
    { PUBLIC_ORIGIN: 'https://remgaz.example.test/' },
    { LEAD_IP_HASH_SECRET: 'short' },
    { HOST: '0.0.0.0' },
    { TRUST_PROXY: 'yes' },
    { PORT: '65536' },
    { TELEGRAM_BOT_TOKEN: '' }
  ]) {
    assert.throws(() => loadConfig({ ...valid, ...change }));
  }
});

test('lead recipient is optional and provided values are preserved after trimming', () => {
  assert.equal(loadConfig(valid).telegramChatId, undefined);
  for (const value of ['', '   ']) {
    assert.equal(loadConfig({ ...valid, TELEGRAM_CHAT_ID: value }).telegramChatId, undefined);
  }
  for (const value of ['123456', '-100123456', '@lead_channel']) {
    assert.equal(loadConfig({ ...valid, TELEGRAM_CHAT_ID: ` ${value} ` }).telegramChatId, value);
  }
});

test('database stays outside dist but may use a sibling directory', () => {
  const dist = fileURLToPath(new URL('../dist/', import.meta.url));
  const nested = fileURLToPath(new URL('../dist/leads.sqlite', import.meta.url));
  const sibling = fileURLToPath(new URL('../dist-neighbor/leads.sqlite', import.meta.url));
  assert.throws(() => loadConfig({ ...valid, LEAD_DB_PATH: dist }), /LEAD_DB_PATH must be outside dist/);
  assert.throws(() => loadConfig({ ...valid, LEAD_DB_PATH: nested }), /LEAD_DB_PATH must be outside dist/);
  assert.equal(loadConfig({ ...valid, LEAD_DB_PATH: sibling }).dbPath, sibling);
});

test('content persists outside release files independently of the lead recipient', () => {
  const config = loadConfig(valid);
  assert.equal(config.contentDbPath, '/var/lib/remgaz/content.sqlite');
  assert.equal(config.contentMediaDir, '/var/lib/remgaz/media');
  const nested = fileURLToPath(new URL('../dist/content.sqlite', import.meta.url));
  assert.throws(() => loadConfig({ ...valid, CONTENT_DB_PATH: nested }), /CONTENT_DB_PATH must be outside dist/);
  assert.throws(() => loadConfig({ ...valid, CONTENT_MEDIA_DIR: nested }), /CONTENT_MEDIA_DIR must be outside dist/);
  assert.throws(() => loadConfig({ ...valid, CONTENT_DB_PATH: valid.LEAD_DB_PATH }), /must differ/);
  assert.throws(() => loadConfig({ ...valid, CONTENT_DB_PATH: './content.sqlite' }), /absolute path/);
  assert.throws(() => loadConfig({ ...valid, CONTENT_MEDIA_DIR: './media' }), /absolute path/);
});
