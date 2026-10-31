import { DurableObject } from "cloudflare:workers";

const ALLOWED_ORIGIN = "https://salewam.github.io";
const MAX_BODY_BYTES = 4096;
const DAY_MS = 24 * 60 * 60 * 1000;

function reply(body, status = 200, cors = true) {
  const headers = {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (cors) {
    headers["Access-Control-Allow-Origin"] = ALLOWED_ORIGIN;
    headers.Vary = "Origin";
  }
  return new Response(JSON.stringify(body), { status, headers });
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
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return { error: "Слишком большая заявка", status: 413 };
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text) };
  } catch {
    return { error: "Некорректный JSON", status: 400 };
  }
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

// One durable object per IP serializes the rolling-window check and delivery.
export class LeadVisitorGuard extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.pending = Promise.resolve();
  }

  runExclusive(work) {
    const task = this.pending.then(work);
    this.pending = task.catch(() => {});
    return task;
  }

  submit(lead) {
    return this.runExclusive(() => this.deliver(lead));
  }

  async deliver({ name, phone, object, location }) {
    const now = Date.now();
    const recent = ((await this.ctx.storage.get("submissions")) || []).filter(
      (time) => time > now - DAY_MS,
    );
    if (recent.length >= 3) {
      return { ok: false, status: 429, error: "Слишком много заявок. Повторите позже" };
    }
    // Rejected repeat visitors must not consume the additional per-location burst limiter.
    const globalLimit = await this.env.LEAD_GLOBAL_LIMIT.limit({ key: "lead" });
    if (!globalLimit.success) {
      return { ok: false, status: 429, error: "Слишком много заявок. Повторите позже" };
    }

    // Reserve before the external call: a restart or uncertain timeout must not
    // allow a fourth delivered message. Known Telegram rejections release the slot.
    const reserved = [...recent, now];
    await this.ctx.storage.put("submissions", reserved);
    await this.ctx.storage.setAlarm(now + DAY_MS);

    const text = [
      "Новая заявка с сайта РемГаз",
      `Имя: ${name}`,
      `Телефон: ${phone}`,
      ...(object ? [`Объект: ${object}`] : []),
      ...(location ? [`Местоположение: ${location}`] : []),
    ].join("\n");
    const controller = new AbortController();
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error("Telegram timed out"));
      }, 8000);
    });
    try {
      // A response body can stall even after fetch resolves. Race the entire
      // exchange; late results must never release a reserved slot.
      const outcome = await Promise.race([timeout, (async () => {
        const telegram = await fetch(`https://api.telegram.org/bot${this.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: this.env.TELEGRAM_CHAT_ID, text }),
          signal: controller.signal,
        });
        if (!telegram.ok) return telegram.status >= 400 && telegram.status < 500 ? "rejected" : "uncertain";
        const result = await telegram.json();
        return result?.ok === true ? "delivered" : result?.ok === false ? "rejected" : "uncertain";
      })()]);
      if (outcome === "rejected") {
        // Only a confirmed Telegram rejection releases the reservation.
        await this.ctx.storage.put("submissions", recent);
      }
      return outcome === "delivered"
        ? { ok: true }
        : { ok: false, status: 502, error: "Не удалось отправить заявку" };
    } catch {
      // A timeout, malformed response, or network error leaves delivery uncertain.
      return { ok: false, status: 502, error: "Не удалось отправить заявку" };
    } finally {
      clearTimeout(timer);
    }
  }

  alarm() {
    return this.runExclusive(async () => {
      const now = Date.now();
      const recent = ((await this.ctx.storage.get("submissions")) || []).filter(
        (time) => time > now - DAY_MS,
      );
      if (!recent.length) {
        await this.ctx.storage.deleteAll();
      } else {
        await this.ctx.storage.put("submissions", recent);
        await this.ctx.storage.setAlarm(recent[recent.length - 1] + DAY_MS);
      }
    });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/lead") return reply({ ok: false, error: "Не найдено" }, 404, false);

    const allowed = request.headers.get("Origin") === ALLOWED_ORIGIN;
    if (!allowed) return reply({ ok: false, error: "Недопустимый источник" }, 403, false);

    if (request.method === "OPTIONS") {
      if (request.headers.get("Access-Control-Request-Method") !== "POST") {
        return reply({ ok: false, error: "Метод не поддерживается" }, 405);
      }
      return new Response(null, {
        status: 204,
        headers: {
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers": "Content-Type",
          "Access-Control-Max-Age": "600",
          "Cache-Control": "no-store",
          Vary: "Origin",
        },
      });
    }
    if (request.method !== "POST") {
      const response = reply({ ok: false, error: "Метод не поддерживается" }, 405);
      response.headers.set("Allow", "POST, OPTIONS");
      return response;
    }
    if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get("Content-Type") || "")) {
      return reply({ ok: false, error: "Ожидается JSON" }, 415);
    }
    const length = Number(request.headers.get("Content-Length"));
    if (length > MAX_BODY_BYTES) return reply({ ok: false, error: "Слишком большая заявка" }, 413);

    const parsed = await readBody(request);
    if (parsed.error) return reply({ ok: false, error: parsed.error }, parsed.status);
    const data = parsed.value;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return reply({ ok: false, error: "Некорректная заявка" }, 400);
    }
    if (typeof data.website !== "string" && data.website !== undefined) {
      return reply({ ok: false, error: "Некорректная заявка" }, 400);
    }
    // Never report delivery for a filled hidden field; it may be autofilled by mistake.
    if (data.website?.trim()) {
      return reply({ ok: false, error: "Проверьте поля заявки" }, 400);
    }

    const name = field(data.name, 100, true);
    const phone = typeof data.phone === "string" ? data.phone.trim() : null;
    const object = field(data.object, 200);
    const location = field(data.location, 200);
    if (name === null || phone === null || phone.length > 40 || !validPhone(phone) || object === null || location === null) {
      return reply({ ok: false, error: "Проверьте поля заявки" }, 400);
    }

    // Origin is a browser CORS boundary, not authentication for script clients.
    const ip = request.headers.get("CF-Connecting-IP");
    if (!ip) return reply({ ok: false, error: "Сервис временно недоступен" }, 503);

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.LEAD_VISITOR_GUARD) {
      return reply({ ok: false, error: "Сервис временно недоступен" }, 503);
    }
    try {
      const id = env.LEAD_VISITOR_GUARD.idFromName(ip);
      const result = await env.LEAD_VISITOR_GUARD.get(id).submit({ name, phone, object, location });
      return reply(result.ok ? { ok: true } : { ok: false, error: result.error }, result.status || 200);
    } catch {
      return reply({ ok: false, error: "Сервис временно недоступен" }, 503);
    }
  },
};
