import { createHmac, timingSafeEqual } from 'node:crypto';

export class TelegramAuthError extends Error {
  constructor(status = 401) {
    super(status === 403 ? 'Доступ разрешён только администраторам.' : 'Недействительные данные входа Telegram.');
    this.name = 'TelegramAuthError';
    this.status = status;
  }
}

export function verifyTelegramInitData(initData, botToken, adminIds, { now = Date.now(), maxAgeSeconds = 3600 } = {}) {
  if (typeof initData !== 'string' || !initData || initData.length > 8192 ||
      typeof botToken !== 'string' || !botToken ||
      !Number.isFinite(now) || now < 0 || !Number.isSafeInteger(maxAgeSeconds) || maxAgeSeconds < 0) {
    throw new TelegramAuthError();
  }

  const params = new URLSearchParams(initData);
  const keys = new Set();
  for (const key of params.keys()) {
    if (keys.has(key)) throw new TelegramAuthError();
    keys.add(key);
  }

  const hash = params.get('hash');
  if (hash === null || !/^[a-fA-F0-9]{64}$/.test(hash)) throw new TelegramAuthError();
  params.delete('hash');
  params.sort();
  const rows = Array.from(params, ([key, value]) => `${key}=${value}`);
  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = createHmac('sha256', secretKey).update(rows.join('\n')).digest();
  if (!timingSafeEqual(expectedHash, Buffer.from(hash, 'hex'))) throw new TelegramAuthError();

  const authDateText = params.get('auth_date');
  if (authDateText === null || !/^(?:0|[1-9][0-9]*)$/.test(authDateText)) throw new TelegramAuthError();
  const authDate = Number(authDateText);
  const age = now / 1000 - authDate;
  if (!Number.isSafeInteger(authDate) || age < -30 || age > maxAgeSeconds) throw new TelegramAuthError();

  let user;
  try { user = JSON.parse(params.get('user')); }
  catch { throw new TelegramAuthError(); }
  if (!user || typeof user !== 'object' || Array.isArray(user) ||
      !Number.isSafeInteger(user.id) || user.id <= 0 ||
      (user.is_bot !== undefined && user.is_bot !== false)) {
    throw new TelegramAuthError();
  }

  const id = String(user.id);
  const allowed = adminIds instanceof Set ? adminIds.has(id) : Array.isArray(adminIds) && adminIds.includes(id);
  if (!allowed) throw new TelegramAuthError(403);
  return user;
}
