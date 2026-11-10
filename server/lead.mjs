import { createHmac } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { isIP } from "node:net";
import { DatabaseSync } from "node:sqlite";

const DAY = 86_400_000;
const MINUTE = 60_000;
const COOLDOWN = 30_000;
const DEDUP = 600_000;
const DEADLINE = 8_000;
const MAX_BODY = 4_096;

function canonicalIp(address) {
  if (isIP(address) === 4) return address.split(".").map(Number).join(".");
  const normalized = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(normalized);
  if (!mapped) return normalized;
  const value = (parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16)) >>> 0;
  return [value >>> 24, (value >>> 16) & 255, (value >>> 8) & 255, value & 255].join(".");
}

function field(value, maximum, required = false) {
  if (value === undefined && !required) return "";
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[\u0000-\u001f\u007f-\u009f\s]+/gu, " ").trim();
  if (cleaned.length > maximum || (required && !cleaned)) return null;
  return cleaned;
}

function validPhone(phone) {
  if (!/^(?:\+?\d+(?:[ -]?\(\d{1,5}\))?|\(\d{1,5}\))(?:[ -]?\d+)*$/.test(phone)) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
}

async function readBody(request) {
  const reader = request.body?.getReader();
  if (!reader) return { error: "Пустая заявка", status: 400 };
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0;
  let text = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY) {
        return { error: "Слишком большая заявка", status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text) };
  } catch {
    return { error: "Некорректный JSON", status: 400 };
  } finally {
    reader.releaseLock();
  }
}

function response(body, status, origin, cors = true) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(cors ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    },
  });
}

function withDeadline(work) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error("External request timed out"));
    }, DEADLINE);
  });
  return Promise.race([deadline, work(controller.signal)]).finally(() => clearTimeout(timer));
}

export function createLeadService(config) {
  const {
    origin, dbPath, ipHashSecret, telegramBotToken, telegramChatId, turnstileSecret,
    fetch: requestFetch = globalThis.fetch, now: clock = Date.now,
  } = config;
  if (!origin || !dbPath || !ipHashSecret || !telegramBotToken || !telegramChatId ||
      Buffer.byteLength(ipHashSecret) < 32 || !/^https?:\/\/[^/]+$/.test(origin)) {
    throw new Error("Invalid lead service configuration");
  }
  const hostname = new URL(origin).hostname;
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
    db.exec(`PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY, ip_hash TEXT NOT NULL, content_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending','confirmed','rejected','uncertain'))
      );
      CREATE INDEX IF NOT EXISTS reservations_ip_time ON reservations(ip_hash,created_at);
      CREATE INDEX IF NOT EXISTS reservations_content_time ON reservations(content_hash,created_at);
      CREATE INDEX IF NOT EXISTS reservations_time ON reservations(created_at);
      CREATE TABLE IF NOT EXISTS request_keys (
        key_hash TEXT PRIMARY KEY, content_hash TEXT NOT NULL,
        reservation_id INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS request_keys_time ON request_keys(created_at);
      CREATE INDEX IF NOT EXISTS request_keys_reservation ON request_keys(reservation_id);
      CREATE TABLE IF NOT EXISTS turnstile_attempts (
        id INTEGER PRIMARY KEY, ip_hash TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS turnstile_attempts_time ON turnstile_attempts(created_at);
      CREATE INDEX IF NOT EXISTS turnstile_attempts_ip_time ON turnstile_attempts(ip_hash,created_at);`);
  } catch (error) {
    db.close();
    throw error;
  }
  const hash = (value) => createHmac("sha256", ipHashSecret).update(value).digest("hex");
  const q = {
    key: db.prepare("SELECT content_hash,reservation_id FROM request_keys WHERE key_hash=? AND created_at>?"),
    reservation: db.prepare("SELECT id,state,created_at FROM reservations WHERE id=?"),
    duplicate: db.prepare(`SELECT id,state,created_at FROM reservations WHERE content_hash=? AND
      ((state='confirmed' AND created_at>?) OR (state IN ('pending','uncertain') AND created_at>?))
      ORDER BY created_at DESC,id DESC LIMIT 1`),
    ipCount: db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE ip_hash=? AND created_at>? AND state!='rejected'"),
    lastIp: db.prepare("SELECT MAX(created_at) AS latest FROM reservations WHERE ip_hash=? AND created_at>? AND state!='rejected'"),
    globalCount: db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE created_at>?"),
    keyBurst: db.prepare("SELECT COUNT(*) AS count FROM request_keys WHERE created_at>?"),
    turnstileCount: db.prepare("SELECT COUNT(*) AS count FROM turnstile_attempts WHERE created_at>?"),
    turnstileIpCount: db.prepare("SELECT COUNT(*) AS count FROM turnstile_attempts WHERE ip_hash=? AND created_at>?"),
    cleanTurnstile: db.prepare("DELETE FROM turnstile_attempts WHERE created_at<=?"),
    insertTurnstile: db.prepare("INSERT INTO turnstile_attempts(ip_hash,created_at) VALUES (?,?)"),
    insert: db.prepare("INSERT INTO reservations(ip_hash,content_hash,created_at,state) VALUES (?,?,?,'pending')"),
    setKey: db.prepare(`INSERT INTO request_keys(key_hash,content_hash,reservation_id,created_at) VALUES (?,?,?,?)
      ON CONFLICT(key_hash) DO UPDATE SET reservation_id=excluded.reservation_id,created_at=excluded.created_at`),
    finish: db.prepare("UPDATE reservations SET state=? WHERE id=? AND state='pending'"),
    cleanKeys: db.prepare("DELETE FROM request_keys WHERE created_at<=?"),
    cleanReservations: db.prepare(`DELETE FROM reservations WHERE created_at<=? AND NOT EXISTS
      (SELECT 1 FROM request_keys WHERE reservation_id=reservations.id)`),
  };

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function allowTurnstileAttempt(ipHash, time) {
    return transaction(() => {
      q.cleanTurnstile.run(time - MINUTE);
      if (q.turnstileIpCount.get(ipHash, time - MINUTE).count >= 10 ||
          q.turnstileCount.get(time - MINUTE).count >= 30) return false;
      q.insertTurnstile.run(ipHash, time);
      return true;
    });
  }

  function reserve(ipHash, contentHash, keyHash, time) {
    return transaction(() => {
      q.cleanKeys.run(time - DAY);
      q.cleanReservations.run(time - DAY);
      const keyed = keyHash ? q.key.get(keyHash, time - DAY) : null;
      if (keyed && keyed.content_hash !== contentHash) return { status: 409, error: "Ключ уже использован для другой заявки" };
      const prior = keyed && q.reservation.get(keyed.reservation_id);
      if (prior && prior.state !== "rejected") return existing(prior, time);
      const duplicate = q.duplicate.get(contentHash, time - DEDUP, time - DAY);
      if (duplicate) {
        if (keyHash && !keyed && q.keyBurst.get(time - MINUTE).count >= 30) {
          return { status: 429, error: "Слишком много заявок. Повторите позже" };
        }
        if (keyHash) q.setKey.run(keyHash, contentHash, duplicate.id, time);
        return existing(duplicate, time);
      }
      if (q.ipCount.get(ipHash, time - DAY).count >= 3 ||
          q.globalCount.get(time - MINUTE).count >= 30) {
        return { status: 429, error: "Слишком много заявок. Повторите позже" };
      }
      const latest = q.lastIp.get(ipHash, time - DAY).latest;
      if (latest !== null && latest > time - COOLDOWN) {
        return { status: 429, error: "Слишком много заявок. Повторите позже" };
      }
      const id = Number(q.insert.run(ipHash, contentHash, time).lastInsertRowid);
      if (keyHash) q.setKey.run(keyHash, contentHash, id, time);
      return { id };
    });
  }

  function existing(record, time) {
    if (record.state === "confirmed") return { status: 200 };
    if (record.state === "pending" && record.created_at > time - DEADLINE) {
      return { status: 409, error: "Заявка уже обрабатывается" };
    }
    return { status: 502, error: "Статус отправки неизвестен" };
  }

  async function verifyTurnstile(token) {
    try {
      const result = await withDeadline(async (signal) => {
        const verification = await requestFetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ secret: turnstileSecret, response: token }), signal,
        });
        if (!verification.ok) return false;
        const data = await verification.json();
        return data?.success === true && data.hostname === hostname && data.action === "lead";
      });
      return result;
    } catch {
      return false;
    }
  }

  async function deliver(lead) {
    const text = [
      "Новая заявка с сайта РемГаз",
      `Имя: ${lead.name}`,
      `Телефон: ${lead.phone}`,
      ...(lead.object ? [`Объект: ${lead.object}`] : []),
      ...(lead.location ? [`Местоположение: ${lead.location}`] : []),
    ].join("\n");
    try {
      return await withDeadline(async (signal) => {
        const telegram = await requestFetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: telegramChatId, text }), signal,
        });
        if (!telegram.ok) return telegram.status >= 400 && telegram.status < 500 ? "rejected" : "uncertain";
        const result = await telegram.json();
        return result?.ok === true ? "confirmed" : result?.ok === false ? "rejected" : "uncertain";
      });
    } catch {
      return "uncertain";
    }
  }

  async function handle(request, clientIp) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/lead") return response({ ok: false, error: "Не найдено" }, 404, origin, false);
    if (request.headers.get("Origin") !== origin) {
      return response({ ok: false, error: "Недопустимый источник" }, 403, origin, false);
    }
    if (request.method === "OPTIONS") {
      if (request.headers.get("Access-Control-Request-Method") !== "POST") {
        return response({ ok: false, error: "Метод не поддерживается" }, 405, origin);
      }
      return new Response(null, { status: 204, headers: {
        "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Methods": "POST",
        "Access-Control-Allow-Headers": "Content-Type, Idempotency-Key", "Access-Control-Max-Age": "600",
        "Cache-Control": "no-store", Vary: "Origin",
      } });
    }
    if (request.method !== "POST") {
      const result = response({ ok: false, error: "Метод не поддерживается" }, 405, origin);
      result.headers.set("Allow", "POST, OPTIONS");
      return result;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") || "")) {
      return response({ ok: false, error: "Ожидается JSON" }, 415, origin);
    }
    if (Number(request.headers.get("Content-Length")) > MAX_BODY) {
      return response({ ok: false, error: "Слишком большая заявка" }, 413, origin);
    }
    const parsed = await readBody(request);
    if (parsed.error) return response({ ok: false, error: parsed.error }, parsed.status, origin);
    const data = parsed.value;
    if (!data || typeof data !== "object" || Array.isArray(data) ||
        (data.website !== undefined && typeof data.website !== "string")) {
      return response({ ok: false, error: "Некорректная заявка" }, 400, origin);
    }
    if (data.website?.trim()) return response({ ok: false, error: "Проверьте поля заявки" }, 400, origin);
    const name = field(data.name, 100, true);
    const phone = typeof data.phone === "string" ? data.phone.trim() : null;
    const object = field(data.object, 200);
    const location = field(data.location, 200);
    if (name === null || phone === null || phone.length > 40 || !validPhone(phone) ||
        object === null || location === null) {
      return response({ ok: false, error: "Проверьте поля заявки" }, 400, origin);
    }
    if (!isIP(clientIp)) return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
    const key = request.headers.get("Idempotency-Key");
    if (key !== null && (!/^[\x21-\x7e]{1,128}$/.test(key) || key.includes(","))) {
      return response({ ok: false, error: "Некорректный ключ заявки" }, 400, origin);
    }
    const ipHash = hash(`ip:${canonicalIp(clientIp)}`);
    const contentHash = hash(`lead:${JSON.stringify([name, phone.replace(/\D/g, ""), object, location])}`);
    const keyHash = key === null ? null : hash(`key:${ipHash}:${key}`);
    if (turnstileSecret && keyHash) {
      let previous;
      try {
        const keyed = q.key.get(keyHash, clock() - DAY);
        if (keyed?.content_hash !== undefined && keyed.content_hash !== contentHash) {
          previous = { status: 409, error: "Ключ уже использован для другой заявки" };
        } else if (keyed) {
          const reservation = q.reservation.get(keyed.reservation_id);
          if (reservation && reservation.state !== "rejected") previous = existing(reservation, clock());
        }
      } catch {
        return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
      }
      if (previous) return response(previous.status === 200 ? { ok: true } : { ok: false, error: previous.error },
        previous.status, origin);
    }
    if (turnstileSecret) {
      if (typeof data.turnstileToken !== "string" || !/^[\w.-]{1,2048}$/.test(data.turnstileToken)) {
        return response({ ok: false, error: "Проверка не пройдена" }, 403, origin);
      }
      let allowed;
      try {
        allowed = allowTurnstileAttempt(ipHash, clock());
      } catch {
        return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
      }
      if (!allowed) return response({ ok: false, error: "Слишком много заявок. Повторите позже" }, 429, origin);
      if (!(await verifyTurnstile(data.turnstileToken))) {
        return response({ ok: false, error: "Проверка не пройдена" }, 403, origin);
      }
    }
    let reservation;
    try {
      reservation = reserve(ipHash, contentHash, keyHash, clock());
    } catch {
      return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
    }
    if (!reservation.id) {
      return response(reservation.status === 200 ? { ok: true } : { ok: false, error: reservation.error },
        reservation.status, origin);
    }
    const outcome = await deliver({ name, phone, object, location });
    try {
      transaction(() => q.finish.run(outcome, reservation.id));
    } catch {
      return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
    }
    return outcome === "confirmed"
      ? response({ ok: true }, 200, origin)
      : response({ ok: false, error: "Не удалось отправить заявку" }, 502, origin);
  }

  return { handle, close: () => db.close() };
}
