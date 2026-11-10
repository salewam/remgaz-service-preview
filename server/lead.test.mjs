import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createLeadService } from "./lead.mjs";

const origin = "https://example.org";
const secret = "local-test-secret-at-least-thirty-two-bytes-long";
const DAY = 86_400_000;
const success = () => new Response('{"ok":true}', { status: 200 });
const phoneCases = JSON.parse(await readFile(new URL("./phone-cases.json", import.meta.url), "utf8"));
const lead = (name = "Тест", phone = "+7 (921) 234-56-78") => ({ name, phone });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture(t, settings = {}) {
  const dir = await mkdtemp(join(tmpdir(), "remgaz-lead-"));
  let time = 1_000_000;
  let delivery = success;
  let verification = () => new Response('{"success":true,"hostname":"example.org","action":"lead"}');
  const calls = [];
  const config = {
    origin, dbPath: join(dir, "lead.sqlite"), ipHashSecret: secret,
    telegramBotToken: "local-test-token", telegramChatId: "local-test-chat",
    now: () => time,
    fetch: (url, options) => {
      calls.push({ url, options });
      return url.startsWith("https://api.telegram.org/") ? delivery(url, options) : verification(url, options);
    },
    ...settings,
  };
  let service = createLeadService(config);
  t.after(async () => { service.close(); await rm(dir, { recursive: true, force: true }); });
  async function submit({ method = "POST", path = "/api/lead", requestOrigin = origin,
    contentType = "application/json", ip = "203.0.113.1", data = lead(),
    body = JSON.stringify(data), headers = {} } = {}) {
    const h = { ...headers };
    if (requestOrigin !== null) h.Origin = requestOrigin;
    if (contentType !== null) h["Content-Type"] = contentType;
    const request = new Request(`${origin}${path}`, {
      method, headers: h, ...(method === "POST" ? { body } : {}),
    });
    const response = await service.handle(request, ip);
    return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
  }
  return {
    config, calls, submit, dbPath: config.dbPath,
    setTime(value) { time = value; }, advance(ms) { time += ms; },
    setDelivery(fn) { delivery = fn; }, setTurnstile(fn) { verification = fn; },
    restart() { service.close(); service = createLeadService(config); },
  };
}

test("simultaneous identical requests have one delivery and a pending 409; global reservation is atomic", async (t) => {
  const app = await fixture(t);
  const stalled = deferred();
  app.setDelivery((_, options) => options.body.includes("Ожидание") ? stalled.promise : success());
  const request = { data: lead("Ожидание"), headers: { "Idempotency-Key": "once" } };
  const first = app.submit(request);
  while (app.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await app.submit(request)).status, 409);
  stalled.resolve(success());
  assert.equal((await first).status, 200);
  assert.equal(app.calls.length, 1);
  app.advance(30_000);
  assert.equal((await app.submit({ data: lead("Второй") })).status, 200);
  app.advance(30_000);
  assert.equal((await app.submit({ data: lead("Третий") })).status, 200);
  app.advance(30_000);
  assert.equal((await app.submit({ data: lead("Четвертый") })).status, 429);
  const global = await fixture(t);
  const results = await Promise.all(Array.from({ length: 35 }, (_, i) => global.submit({
    ip: `198.51.100.${i + 1}`, data: lead(`Имя ${i}`),
  }).then(({ status }) => status)));
  assert.equal(results.filter((status) => status === 200).length, 30);
  assert.equal(results.filter((status) => status === 429).length, 5);
  assert.equal(global.calls.length, 30);
});

test("global minute window reopens exactly at boundary without pruning fresh daily records", async (t) => {
  const app = await fixture(t);
  for (let i = 0; i < 30; i++) {
    assert.equal((await app.submit({ ip: `198.51.100.${i + 1}`, data: lead(`Имя ${i}`) })).status, 200);
  }
  assert.equal((await app.submit({ ip: "198.51.100.31", data: lead("Заблокирован") })).status, 429);
  app.advance(60_000);
  assert.equal((await app.submit({ ip: "198.51.100.31", data: lead("Освобожден") })).status, 200);
  app.advance(DAY - 60_001);
  assert.equal((await app.submit({ ip: "198.51.100.32", data: lead("Перед границей") })).status, 200);
  app.advance(1);
  assert.equal((await app.submit({ ip: "198.51.100.33", data: lead("После границы") })).status, 200);
  const db = new DatabaseSync(app.dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reservations WHERE created_at=?").get(1_060_000).count, 1);
  db.close();
});

test("rolling window and cooldown persist across restart", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.submit({ data: lead("Первый") })).status, 200);
  app.advance(29_999);
  assert.equal((await app.submit({ data: lead("Второй") })).status, 429);
  app.advance(1);
  assert.equal((await app.submit({ data: lead("Второй") })).status, 200);
  app.advance(30_000);
  assert.equal((await app.submit({ data: lead("Третий") })).status, 200);
  app.restart();
  app.advance(DAY - 60_001);
  assert.equal((await app.submit({ data: lead("Четвертый") })).status, 429);
  app.advance(1);
  assert.equal((await app.submit({ data: lead("Четвертый") })).status, 200);
  assert.equal(app.calls.length, 4);
});

test("normalized content deduplicates for ten minutes; an idempotency key survives a restart", async (t) => {
  const app = await fixture(t);
  const first = { data: lead("  Иван   Иванов  "), headers: { "Idempotency-Key": "client-17" } };
  assert.equal((await app.submit(first)).status, 200);
  app.advance(9 * 60_000);
  assert.equal((await app.submit({ ip: "198.51.100.5", data: lead("Иван Иванов", "79212345678") })).status, 200);
  assert.equal(app.calls.length, 1);
  app.restart();
  app.advance(60_000);
  assert.equal((await app.submit(first)).status, 200);
  assert.equal((await app.submit({ ...first, data: lead("Другой") })).status, 409);
  assert.equal((await app.submit({ ip: "198.51.100.5", data: lead("Иван Иванов", "79212345678") })).status, 200);
  assert.equal(app.calls.length, 2);
  assert.equal((await app.submit({ headers: { "Idempotency-Key": "bad,key" } })).status, 400);
});

test("equivalent IPv6 and mapped IPv4 addresses share IP rate limits", async (t) => {
  const app = await fixture(t);
  const ips = ["2001:db8::1", "2001:0db8:0:0:0:0:0:1", "2001:db8::1"];
  for (let i = 0; i < ips.length; i++) {
    app.advance(30_000);
    assert.equal((await app.submit({ ip: ips[i], data: lead(`IPv6 ${i}`) })).status, 200);
  }
  app.advance(30_000);
  assert.equal((await app.submit({ ip: "2001:0db8::1", data: lead("Четвертый") })).status, 429);
  for (let i = 0; i < 3; i++) {
    app.advance(30_000);
    assert.equal((await app.submit({ ip: i % 2 ? "::ffff:c000:201" : "192.0.2.1", data: lead(`Mapped ${i}`) })).status, 200);
  }
  app.advance(30_000);
  assert.equal((await app.submit({ ip: "::ffff:192.0.2.1", data: lead("Mapped fourth") })).status, 429);
});

test("idempotency keys are scoped to the validated client IP", async (t) => {
  const app = await fixture(t);
  const headers = { "Idempotency-Key": "shared-key" };
  assert.equal((await app.submit({ ip: "198.51.100.1", headers, data: lead("Чужой") })).status, 200);
  app.advance(30_000);
  assert.equal((await app.submit({ ip: "198.51.100.2", headers, data: lead("Своя заявка") })).status, 200);
  assert.equal(app.calls.length, 2);
});

test("new idempotency aliases are bounded; old aliased reservation survives key TTL", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.submit({ data: lead("Совпадение") })).status, 200);
  app.advance(9 * 60_000);
  for (let i = 0; i < 30; i++) {
    assert.equal((await app.submit({ data: lead("Совпадение"), headers: { "Idempotency-Key": `alias-${i}` } })).status, 200);
  }
  assert.equal((await app.submit({ data: lead("Совпадение"), headers: { "Idempotency-Key": "alias-31" } })).status, 429);
  assert.equal((await app.submit({ data: lead("Совпадение"), headers: { "Idempotency-Key": "alias-0" } })).status, 200);
  app.restart();
  app.advance(DAY - 9 * 60_000 + 1);
  assert.equal((await app.submit({ data: lead("Совпадение"), headers: { "Idempotency-Key": "alias-0" } })).status, 200);
  assert.equal(app.calls.length, 1);
});

test("Telegram 4xx and ok:false release the daily slot; uncertain failures retain it without retry", async (t) => {
  for (const reject of [() => new Response("rejected", { status: 400 }),
    () => new Response('{"ok":false}', { status: 200 })]) {
    await t.test("known rejection", async (sub) => {
      const app = await fixture(sub);
      app.setDelivery(() => app.calls.length === 1 ? reject() : success());
      const keyed = { headers: { "Idempotency-Key": "retry" } };
      assert.equal((await app.submit(keyed)).status, 502);
      assert.equal((await app.submit(keyed)).status, 200);
      for (let i = 0; i < 2; i++) {
        app.advance(30_000);
        assert.equal((await app.submit({ data: lead(`Дополнительный ${i}`) })).status, 200);
      }
      app.advance(30_000);
      assert.equal((await app.submit({ data: lead("Четвертый") })).status, 429);
      assert.equal(app.calls.length, 4);
    });
  }
  for (const uncertain of [() => new Response("error", { status: 500 }),
    () => new Response("{", { status: 200 }), () => new Response("{}", { status: 200 }),
    () => Promise.reject(new Error("network failed"))]) {
    await t.test("uncertain", async (sub) => {
      const app = await fixture(sub);
      app.setDelivery(uncertain);
      assert.equal((await app.submit({ headers: { "Idempotency-Key": "same" } })).status, 502);
      app.restart();
      assert.equal((await app.submit({ headers: { "Idempotency-Key": "same" } })).status, 502);
      app.advance(11 * 60_000);
      assert.equal((await app.submit()).status, 502);
      assert.equal(app.calls.length, 1);
    });
  }
});

test("eight-second deadline covers Telegram JSON body, reserves uncertain outcome", async (t) => {
  const app = await fixture(t);
  let signal;
  app.setDelivery((_, options) => {
    signal = options.signal;
    return { ok: true, json: () => new Promise(() => {}) };
  });
  assert.equal((await app.submit({ headers: { "Idempotency-Key": "slow" } })).status, 502);
  assert.equal(signal.aborted, true);
  app.restart();
  assert.equal((await app.submit({ headers: { "Idempotency-Key": "slow" } })).status, 502);
  assert.equal(app.calls.length, 1);
});

test("request boundaries: spoofed IP, origin, stream body cap, UTF-8, preflight, honeypot", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.submit({ requestOrigin: null })).status, 403);
  assert.equal((await app.submit({ requestOrigin: origin + ".evil" })).status, 403);
  assert.equal((await app.submit({ ip: "not-ip", headers: { "X-Real-IP": "203.0.113.1" } })).status, 503);
  assert.equal((await app.submit({ contentType: "text/plain" })).status, 415);
  assert.equal((await app.submit({ path: "/worker/lead" })).status, 404);
  assert.equal((await app.submit({ headers: { "Content-Length": "4097" } })).status, 413);
  assert.equal((await app.submit({ body: "x".repeat(4097) })).status, 413);
  assert.equal((await app.submit({ body: new Uint8Array([0x7b, 0xff, 0x7d]) })).status, 400);
  assert.equal((await app.submit({ body: "{" })).status, 400);
  assert.equal((await app.submit({ data: { ...lead(), website: "spam" } })).status, 400);
  assert.equal((await app.submit({ data: { ...lead(), website: 1 } })).status, 400);
  assert.equal((await app.submit({ data: { ...lead(), ip: "198.51.100.1" } })).status, 200);
  app.advance(30_000);
  assert.equal((await app.submit({ data: { ...lead("Другой"), ip: "198.51.100.2" } })).status, 200);
  assert.equal(app.calls.length, 2);
  assert.match(app.calls[0].url, /^https:\/\/api\.telegram\.org\/bot/);
  const preflight = await app.submit({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await app.submit({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "DELETE" } })).status, 405);
  assert.equal((await app.submit({ method: "GET" })).status, 405);
});

test("phone cases have identical acceptance to the previous Worker", async (t) => {
  const app = await fixture(t);
  let accepted = 0;
  for (const { phone, valid } of phoneCases) {
    const status = (await app.submit({ ip: `198.51.100.${accepted + 1}`, data: lead(`Имя ${accepted}`, phone) })).status;
    assert.equal(status, valid ? 200 : 400, JSON.stringify(phone));
    if (valid) accepted++;
  }
  for (const phone of [null, 79212345678, { value: "79212345678" }]) {
    assert.equal((await app.submit({ data: lead("Не телефон", phone) })).status, 400);
  }
  assert.equal(app.calls.length, accepted);
});

test("SQLite contains hashes rather than IP, phone, body or key", async (t) => {
  const app = await fixture(t);
  assert.equal((await app.submit({ headers: { "Idempotency-Key": "private-key" } })).status, 200);
  const db = new DatabaseSync(app.dbPath);
  const record = db.prepare("SELECT * FROM reservations").get();
  const key = db.prepare("SELECT * FROM request_keys").get();
  db.close();
  assert.equal(record.ip_hash, createHmac("sha256", secret).update("ip:203.0.113.1").digest("hex"));
  assert.equal(record.content_hash.length, 64);
  assert.equal(key.key_hash.length, 64);
  assert.doesNotMatch(JSON.stringify([record, key]), /203\.0\.113\.1|79212345678|private-key/);
});

test("optional Turnstile requires valid token, expected hostname and action", async (t) => {
  const app = await fixture(t, { turnstileSecret: "local-turnstile-secret" });
  assert.equal((await app.submit()).status, 403);
  const token = (value) => ({ data: { ...lead(), turnstileToken: value } });
  app.setTurnstile(() => new Response('{"success":true,"hostname":"wrong.org","action":"lead"}'));
  assert.equal((await app.submit(token("wrong-host"))).status, 403);
  app.setTurnstile(() => new Response('{"success":true,"hostname":"example.org","action":"wrong"}'));
  assert.equal((await app.submit(token("wrong-action"))).status, 403);
  app.setTurnstile(() => new Response('{"success":false,"hostname":"example.org","action":"lead"}'));
  assert.equal((await app.submit(token("expired"))).status, 403);
  app.setTurnstile(() => new Response('{"success":true,"hostname":"example.org","action":"lead"}'));
  assert.equal((await app.submit(token("valid"))).status, 200);
  const verification = app.calls.find(({ url }) => url.includes("siteverify"));
  assert.equal(verification.url, "https://challenges.cloudflare.com/turnstile/v0/siteverify");
  assert.equal(new URLSearchParams(verification.options.body).get("secret"), "local-turnstile-secret");
  assert.equal(app.calls.filter(({ url }) => url.startsWith("https://api.telegram.org/")).length, 1);
});

test("Turnstile siteverify outbound attempts are bounded and persist across restart", async (t) => {
  const app = await fixture(t, { turnstileSecret: "local-turnstile-secret" });
  const payload = { data: { ...lead(), turnstileToken: "invalid-token" } };
  app.setTurnstile(() => new Response('{"success":false}'));
  for (let i = 0; i < 30; i++) {
    assert.equal((await app.submit({ ...payload, ip: `198.51.100.${Math.floor(i / 10) + 1}` })).status, 403);
  }
  app.restart();
  assert.equal((await app.submit({ ...payload, ip: "198.51.100.4" })).status, 429);
  assert.equal(app.calls.length, 30);
  app.advance(60_000);
  assert.equal((await app.submit({ ...payload, ip: "198.51.100.4" })).status, 403);
  assert.equal(app.calls.length, 31);
});

test("one IP cannot exhaust Turnstile verification for another and verified keyed retry needs no new token", async (t) => {
  const app = await fixture(t, { turnstileSecret: "local-turnstile-secret" });
  const token = (value) => ({ data: { ...lead(), turnstileToken: value } });
  app.setTurnstile(() => new Response('{"success":false}'));
  for (let i = 0; i < 10; i++) assert.equal((await app.submit(token(`invalid-${i}`))).status, 403);
  assert.equal((await app.submit(token("invalid-10"))).status, 429);
  app.setTurnstile(() => new Response('{"success":true,"hostname":"example.org","action":"lead"}'));
  const keyed = { ip: "198.51.100.2", data: { ...lead(), turnstileToken: "one-time" },
    headers: { "Idempotency-Key": "verified-key" } };
  assert.equal((await app.submit(keyed)).status, 200);
  app.restart();
  app.setTurnstile(() => new Response('{"success":false}'));
  assert.equal((await app.submit({ ...keyed, data: lead() })).status, 200);
  assert.equal(app.calls.filter(({ url }) => url.includes("siteverify")).length, 11);
  assert.equal(app.calls.filter(({ url }) => url.startsWith("https://api.telegram.org/")).length, 1);
});
