const ALLOWED_ORIGIN = "https://salewam.github.io";
const MAX_BODY_BYTES = 4096;

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
    const phone = field(data.phone, 40, true);
    const object = field(data.object, 200);
    const location = field(data.location, 200);
    if (name === null || phone === null || object === null || location === null) {
      return reply({ ok: false, error: "Проверьте поля заявки" }, 400);
    }

    // Origin is a browser CORS boundary, not authentication for script clients.
    // The global cap also bounds traffic from clients that change IP addresses.
    try {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const visitorLimit = await env.LEAD_VISITOR_LIMIT.limit({ key: ip });
      if (!visitorLimit.success) {
        return reply({ ok: false, error: "Слишком много заявок. Повторите позже" }, 429);
      }
      const globalLimit = await env.LEAD_GLOBAL_LIMIT.limit({ key: "lead" });
      if (!globalLimit.success) {
        return reply({ ok: false, error: "Слишком много заявок. Повторите позже" }, 429);
      }
    } catch {
      return reply({ ok: false, error: "Сервис временно недоступен" }, 503);
    }

    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
      return reply({ ok: false, error: "Сервис временно недоступен" }, 503);
    }
    const text = [
      "Новая заявка с сайта РемГаз",
      `Имя: ${name}`,
      `Телефон: ${phone}`,
      ...(object ? [`Объект: ${object}`] : []),
      ...(location ? [`Местоположение: ${location}`] : []),
    ].join("\n");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const telegram = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
        signal: controller.signal,
      });
      const result = await telegram.json();
      if (!telegram.ok || result?.ok !== true) {
        return reply({ ok: false, error: "Не удалось отправить заявку" }, 502);
      }
      return reply({ ok: true });
    } catch {
      return reply({ ok: false, error: "Не удалось отправить заявку" }, 502);
    } finally {
      clearTimeout(timer);
    }
  },
};
