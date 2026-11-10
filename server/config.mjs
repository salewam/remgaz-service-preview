import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(fileURLToPath(new URL('../dist/', import.meta.url)));

export function loadConfig(env = process.env) {
  const required = name => {
    const value = env[name];
    if (!value || !value.trim()) throw new Error(`Missing required environment variable: ${name}`);
    return value.trim();
  };
  const rawOrigin = required('PUBLIC_ORIGIN');
  let origin;
  try {
    const parsed = new URL(rawOrigin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== rawOrigin) throw new Error();
    origin = parsed.origin;
  } catch { throw new Error('PUBLIC_ORIGIN must be a bare http(s) origin'); }

  const telegramBotToken = required('TELEGRAM_BOT_TOKEN');
  const telegramChatId = env.TELEGRAM_CHAT_ID?.trim() || undefined;
  const ipHashSecret = required('LEAD_IP_HASH_SECRET');
  if (Buffer.byteLength(ipHashSecret) < 32) throw new Error('LEAD_IP_HASH_SECRET must be at least 32 bytes');
  const dbPath = required('LEAD_DB_PATH');
  if (!isAbsolute(dbPath)) throw new Error('LEAD_DB_PATH must be an absolute path');
  const relativeDb = relative(dist, resolve(dbPath));
  if (!relativeDb || (!relativeDb.startsWith(`..${sep}`) && relativeDb !== '..')) {
    throw new Error('LEAD_DB_PATH must be outside dist');
  }
  const host = env.HOST || '127.0.0.1';
  if (!['127.0.0.1', '::1'].includes(host)) throw new Error('HOST must be a loopback address');
  const rawPort = env.PORT || '8080';
  if (!/^\d+$/.test(rawPort) || Number(rawPort) < 1 || Number(rawPort) > 65535) {
    throw new Error('PORT must be an integer from 1 to 65535');
  }
  const trustProxy = env.TRUST_PROXY || 'false';
  if (!['true', 'false'].includes(trustProxy)) throw new Error('TRUST_PROXY must be true or false');
  const turnstileSecret = env.TURNSTILE_SECRET?.trim() || undefined;
  const outsideDist = (name, value) => {
    if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path`);
    const path = resolve(value);
    const fromDist = relative(dist, path);
    if (!fromDist || (!fromDist.startsWith(`..${sep}`) && fromDist !== '..')) {
      throw new Error(`${name} must be outside dist`);
    }
    return path;
  };
  const contentDbPath = outsideDist('CONTENT_DB_PATH', env.CONTENT_DB_PATH || join(dirname(dbPath), 'content.sqlite'));
  const contentMediaDir = outsideDist('CONTENT_MEDIA_DIR', env.CONTENT_MEDIA_DIR || join(dirname(dbPath), 'media'));
  if (contentDbPath === resolve(dbPath)) throw new Error('CONTENT_DB_PATH must differ from LEAD_DB_PATH');
  if (contentMediaDir === contentDbPath || contentMediaDir === resolve(dbPath)) {
    throw new Error('CONTENT_MEDIA_DIR must be a separate directory');
  }
  return {
    origin, telegramBotToken, telegramChatId, ipHashSecret, dbPath,
    host, port: Number(rawPort), trustProxy: trustProxy === 'true', turnstileSecret,
    contentDbPath, contentMediaDir
  };
}
