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
    origin, leadAllowedOrigins = [origin], dbPath, ipHashSecret, telegramBotToken, telegramChatId, turnstileSecret,
    fetch: requestFetch = globalThis.fetch, now: clock = Date.now,
  } = config;
  if (!origin || !dbPath || !ipHashSecret || !telegramBotToken ||
      Buffer.byteLength(ipHashSecret) < 32 || !/^https?:\/\/[^/]+$/.test(origin)) {
    throw new Error("Invalid lead service configuration");
  }
  const hostname = new URL(origin).hostname;
  const allowedOrigins = new Set([origin, ...leadAllowedOrigins]);
  mkdirSync(dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  try {
    chmodSync(dbPath, 0o600);
    db.exec(`PRAGMA busy_timeout=1000;
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
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
      CREATE INDEX IF NOT EXISTS turnstile_attempts_ip_time ON turnstile_attempts(ip_hash,created_at);
      CREATE TABLE IF NOT EXISTS leads (
        id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL,
        name TEXT NOT NULL, phone TEXT NOT NULL, object TEXT NOT NULL, location TEXT NOT NULL,
        delivery TEXT NOT NULL CHECK (delivery IN ('queued','sending','sent','rejected','uncertain')),
        recipient TEXT
      );
      CREATE TABLE IF NOT EXISTS lead_recipient (
        id INTEGER PRIMARY KEY CHECK (id=1), chat_id TEXT NOT NULL
      );`);
  } catch (error) {
    db.close();
    throw error;
  }
  const hash = (value) => createHmac("sha256", ipHashSecret).update(value).digest("hex");
  const q = {
    key: db.prepare("SELECT content_hash,reservation_id FROM request_keys WHERE key_hash=? AND created_at>?"),
    reservation: db.prepare(`SELECT r.id,r.state,r.created_at,l.delivery FROM reservations r
      LEFT JOIN leads l ON l.id=r.id WHERE r.id=?`),
    duplicate: db.prepare(`SELECT r.id,r.state,r.created_at,l.delivery FROM reservations r
      LEFT JOIN leads l ON l.id=r.id WHERE content_hash=? AND
      ((state='confirmed' AND r.created_at>?) OR (state IN ('pending','rejected','uncertain') AND r.created_at>?))
      ORDER BY r.created_at DESC,r.id DESC LIMIT 1`),
    ipCount: db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE ip_hash=? AND created_at>?"),
    lastIp: db.prepare("SELECT MAX(created_at) AS latest FROM reservations WHERE ip_hash=? AND created_at>?"),
    globalCount: db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE created_at>?"),
    keyBurst: db.prepare("SELECT COUNT(*) AS count FROM request_keys WHERE created_at>?"),
    turnstileCount: db.prepare("SELECT COUNT(*) AS count FROM turnstile_attempts WHERE created_at>?"),
    turnstileIpCount: db.prepare("SELECT COUNT(*) AS count FROM turnstile_attempts WHERE ip_hash=? AND created_at>?"),
    cleanTurnstile: db.prepare("DELETE FROM turnstile_attempts WHERE created_at<=?"),
    insertTurnstile: db.prepare("INSERT INTO turnstile_attempts(ip_hash,created_at) VALUES (?,?)"),
    insert: db.prepare(`INSERT INTO reservations(id,ip_hash,content_hash,created_at,state)
      SELECT MAX(COALESCE((SELECT MAX(id) FROM reservations),0),
        COALESCE((SELECT MAX(id) FROM leads),0))+1,?,?,?,'pending'`),
    setKey: db.prepare(`INSERT INTO request_keys(key_hash,content_hash,reservation_id,created_at) VALUES (?,?,?,?)
      ON CONFLICT(key_hash) DO UPDATE SET reservation_id=excluded.reservation_id,created_at=excluded.created_at`),
    finish: db.prepare("UPDATE reservations SET state=? WHERE id=?"),
    insertLead: db.prepare(`INSERT INTO leads(id,created_at,name,phone,object,location,delivery)
      VALUES (?,?,?,?,?,?,'queued')`),
    lead: db.prepare('SELECT * FROM leads WHERE id=?'),
    list: db.prepare('SELECT * FROM leads ORDER BY created_at DESC,id DESC'),
    queued: db.prepare("SELECT id FROM leads WHERE delivery='queued' ORDER BY created_at,id"),
    claim: db.prepare("UPDATE leads SET delivery='sending',recipient=? WHERE id=? AND delivery='queued'"),
    delivered: db.prepare("UPDATE leads SET delivery=? WHERE id=? AND delivery='sending'"),
    recipient: db.prepare('SELECT chat_id FROM lead_recipient WHERE id=1'),
    bind: db.prepare('INSERT INTO lead_recipient(id,chat_id) VALUES (1,?) ON CONFLICT(id) DO NOTHING'),
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

  function reserve(ipHash, contentHash, keyHash, time, lead) {
    return transaction(() => {
      q.cleanKeys.run(time - DAY);
      q.cleanReservations.run(time - DAY);
      const keyed = keyHash ? q.key.get(keyHash, time - DAY) : null;
      if (keyed && keyed.content_hash !== contentHash) return { status: 409, error: "Ключ уже использован для другой заявки" };
      const prior = keyed && q.reservation.get(keyed.reservation_id);
      if (prior) return existing(prior, time);
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
      q.insertLead.run(id, time, lead.name, lead.phone, lead.object, lead.location);
      if (keyHash) q.setKey.run(keyHash, contentHash, id, time);
      return { id };
    });
  }

  function existing(record, time) {
    // Historical reservations without saved fields cannot confirm durable acceptance.
    if (!record.delivery) {
      if (record.state === 'confirmed') return { status: 409, error: 'Заявка уже была отправлена. При необходимости позвоните нам.' };
      return { status: 409, error: 'Статус прежней отправки неизвестен. Пожалуйста, позвоните нам.' };
    }
    return { status: 200, delivery: record.delivery === 'sent' ? 'sent' : 'queued' };
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

  async function deliver(lead, recipient) {
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
          body: JSON.stringify({ chat_id: recipient, text }), signal,
        });
        if (!telegram.ok) return telegram.status >= 400 && telegram.status < 500 ? "rejected" : "uncertain";
        const result = await telegram.json();
        return result?.ok === true ? "confirmed" : result?.ok === false ? "rejected" : "uncertain";
      });
    } catch {
      return "uncertain";
    }
  }

  function recipient() {
    return telegramChatId || q.recipient.get()?.chat_id;
  }

  async function deliverSaved(id) {
    const chatId = recipient();
    if (!chatId || q.claim.run(String(chatId), id).changes !== 1) return;
    const outcome = await deliver(q.lead.get(id), chatId);
    // The durable claim stays non-retryable if this commit fails or the process stops.
    transaction(() => {
      q.delivered.run(outcome === 'confirmed' ? 'sent' : outcome, id);
      q.finish.run(outcome, id);
    });
  }

  let flushing;
  function flushQueued() {
    if (!recipient()) return Promise.resolve();
    if (!flushing) {
      flushing = (async () => {
        for (const { id } of q.queued.all()) await deliverSaved(id);
      })().finally(() => { flushing = null; });
    }
    return flushing;
  }

  async function bindOperator(user) {
    const botId = telegramBotToken.split(':', 1)[0];
    if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 ||
        (user.is_bot !== undefined && user.is_bot !== false) || String(user.id) === botId) return;
    if (!telegramChatId) transaction(() => q.bind.run(String(user.id)));
    await flushQueued();
  }

  function listLeads() {
    return q.list.all().map(lead => ({
      id: lead.id, createdAt: new Date(lead.created_at).toISOString(),
      name: lead.name, phone: lead.phone, object: lead.object, location: lead.location,
      delivery: lead.delivery === 'sending' ? 'uncertain' : lead.delivery,
    }));
  }

  async function handle(request, clientIp) {
    const origin = request.headers.get("Origin");
    const url = new URL(request.url);
    if (url.pathname !== "/api/lead") return response({ ok: false, error: "Не найдено" }, 404, origin, false);
    if (!allowedOrigins.has(origin)) {
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
          if (reservation) previous = existing(reservation, clock());
        }
      } catch {
        return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
      }
      if (previous) return response(previous.status === 200 ? { ok: true, delivery: previous.delivery } : { ok: false, error: previous.error },
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
      reservation = reserve(ipHash, contentHash, keyHash, clock(), { name, phone, object, location });
    } catch {
      return response({ ok: false, error: "Сервис временно недоступен" }, 503, origin);
    }
    if (!reservation.id) {
      return response(reservation.status === 200 ? { ok: true, delivery: reservation.delivery } : { ok: false, error: reservation.error },
        reservation.status, origin);
    }
    try { await deliverSaved(reservation.id); }
    catch { /* The saved lead remains visible; an uncertain claim is never retried. */ }
    return response({ ok: true, delivery: q.lead.get(reservation.id).delivery === 'sent' ? 'sent' : 'queued' }, 200, origin);
  }

  let closed = false;
  // Resume only unclaimed durable work; interrupted sending rows remain non-retryable.
  queueMicrotask(() => { if (!closed) void flushQueued().catch(() => {}); });
  return { handle, bindOperator, listLeads, close() { if (!closed) { db.close(); closed = true; } } };
}
