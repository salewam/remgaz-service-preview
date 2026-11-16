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
    listLeads() { return service.listLeads(); },
    bindOperator(user) { return service.bindOperator(user); },
    connect() { return createLeadService(config); },
    setTime(value) { time = value; }, advance(ms) { time += ms; },
    setDelivery(fn) { delivery = fn; }, setTurnstile(fn) { verification = fn; },
    restart() { service.close(); service = createLeadService(config); },
  };
}

test("simultaneous identical requests persist before delivery and return queued; global reservation is atomic", async (t) => {
  const app = await fixture(t);
  const stalled = deferred();
  t.after(() => stalled.resolve(success()));
  app.setDelivery((_, options) => options.body.includes("Ожидание") ? stalled.promise : success());
  const request = { data: lead("Ожидание"), headers: { "Idempotency-Key": "once" } };
  const first = app.submit(request);
  while (app.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
  const pending = await app.submit(request);
  assert.equal(pending.status, 200);
  assert.deepEqual(pending.body, { ok: true, delivery: "queued" });
  assert.equal(app.listLeads().length, 1);
  assert.equal(app.listLeads()[0].delivery, "uncertain", "An in-flight attempt is not safely queued for retry");
  const persisted = new DatabaseSync(app.dbPath, { readOnly: true });
  try { assert.equal(persisted.prepare("SELECT COUNT(*) AS count FROM leads").get().count, 1); }
  finally { persisted.close(); }
  stalled.resolve(success());
  const completed = await first;
  assert.equal(completed.status, 200);
  assert.deepEqual(completed.body, { ok: true, delivery: "sent" });
  assert.equal(app.listLeads()[0].delivery, "sent");
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

test("Telegram failures stay accepted, retain daily slots and never retry persisted attempts", async (t) => {
  const outcomes = [
    ["HTTP rejection", "rejected", () => new Response("rejected", { status: 400 })],
    ["API rejection", "rejected", () => new Response('{"ok":false}', { status: 200 })],
    ["server failure", "uncertain", () => new Response("error", { status: 500 })],
    ["invalid JSON", "uncertain", () => new Response("{", { status: 200 })],
    ["missing result", "uncertain", () => new Response("{}", { status: 200 })],
    ["network failure", "uncertain", () => Promise.reject(new Error("network failed"))],
  ];
  for (const [label, delivery, fail] of outcomes) {
    await t.test(label, async (sub) => {
      const app = await fixture(sub);
      app.setDelivery(fail);
      const keyed = { headers: { "Idempotency-Key": "same" } };
      const accepted = await app.submit(keyed);
      assert.equal(accepted.status, 200);
      assert.deepEqual(accepted.body, { ok: true, delivery: "queued" });
      assert.equal(app.listLeads()[0].delivery, delivery);
      app.restart();
      app.setDelivery(success);
      const replay = await app.submit(keyed);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.body, accepted.body);
      app.advance(11 * 60_000);
      assert.deepEqual((await app.submit()).body, accepted.body);
      await app.bindOperator({ id: 987654321, is_bot: false });
      assert.equal(app.calls.length, 1);
      assert.equal(app.listLeads().length, 1);
      assert.equal(app.listLeads()[0].delivery, delivery);
      for (let i = 0; i < 2; i++) {
        assert.equal((await app.submit({ data: lead(`Дополнительный ${i}`) })).status, 200);
        app.advance(30_000);
      }
      assert.equal((await app.submit({ data: lead("Четвертый") })).status, 429);
      assert.equal(app.calls.length, 3, "A failed Telegram attempt must not free a durable lead's daily slot");
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
  const accepted = await app.submit({ headers: { "Idempotency-Key": "slow" } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { ok: true, delivery: "queued" });
  assert.equal(app.listLeads()[0].delivery, "uncertain");
  assert.equal(signal.aborted, true);
  app.restart();
  assert.deepEqual((await app.submit({ headers: { "Idempotency-Key": "slow" } })).body, accepted.body);
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

test("explicit Pages origin supports preflight, delivery and readable failures without allowing other sites", async (t) => {
  const pagesOrigin = "https://salewam.github.io";
  const app = await fixture(t, { leadAllowedOrigins: [pagesOrigin] });
  const preflight = await app.submit({ method: "OPTIONS", requestOrigin: pagesOrigin,
    headers: { "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(preflight.headers.get("Vary"), "Origin");
  const delivered = await app.submit({ requestOrigin: pagesOrigin });
  assert.equal(delivered.status, 200);
  assert.equal(delivered.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  assert.equal(app.calls.length, 1);
  const sameSite = await app.submit();
  assert.equal(sameSite.status, 200);
  assert.equal(sameSite.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(app.calls.length, 1);
  const invalid = await app.submit({ requestOrigin: pagesOrigin, data: { name: "" } });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.headers.get("Access-Control-Allow-Origin"), pagesOrigin);
  for (const requestOrigin of [null, "null", pagesOrigin + ".evil", "https://another.github.io"]) {
    const denied = await app.submit({ requestOrigin });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("Access-Control-Allow-Origin"), null);
  }
  assert.equal(app.calls.length, 1);
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

test("rate-limit and idempotency records contain hashes rather than raw IP, phone, body or key", async (t) => {
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

test("without a recipient accepted fields survive restart, omit secrets and remain newest-first", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  const data = {
    ...lead("  Иван\n Иванов  "), object: "  Частный\tдом ", location: "  Ленинградская\n область ",
    user: { id: 555 }, chat: { id: 666 }, chat_id: 777, id: 888,
    ip: "198.51.100.123", turnstileToken: "private-turnstile-token", extra: "not-a-lead-field",
  };
  const accepted = await app.submit({ data, headers: { "Idempotency-Key": "private-key" } });
  assert.equal(accepted.status, 200);
  assert.deepEqual(accepted.body, { ok: true, delivery: "queued" });
  assert.equal(app.calls.length, 0, "Public user/chat/id must not choose a Telegram recipient");
  const [stored] = app.listLeads();
  assert.deepEqual(Object.keys(stored).sort(), ["createdAt", "delivery", "id", "location", "name", "object", "phone"]);
  assert.ok(stored.id);
  assert.deepEqual(stored, {
    id: stored.id, createdAt: new Date(1_000_000).toISOString(), delivery: "queued",
    name: "Иван Иванов", phone: data.phone, object: "Частный дом", location: "Ленинградская область",
  });
  const db = new DatabaseSync(app.dbPath, { readOnly: true });
  try {
    const rows = db.prepare("SELECT * FROM leads").all();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, stored.name);
    assert.equal(rows[0].phone, stored.phone);
    assert.equal(rows[0].object, stored.object);
    assert.equal(rows[0].location, stored.location);
    const serialized = JSON.stringify(rows);
    for (const privateValue of ["203.0.113.1", data.ip, "private-key", data.turnstileToken,
      app.config.telegramBotToken, secret, "not-a-lead-field"]) assert.equal(serialized.includes(privateValue), false);
  } finally { db.close(); }
  app.restart();
  assert.deepEqual(app.listLeads(), [stored]);
  app.advance(30_000);
  assert.deepEqual((await app.submit({ data: lead("Новая") })).body, accepted.body);
  assert.deepEqual(app.listLeads().map(row => row.name), ["Новая", "Иван Иванов"]);
  app.advance(DAY);
  await app.submit({ data: lead("Через сутки") });
  app.restart();
  assert.equal(app.listLeads().length, 3, "Rate-limit pruning must not erase accepted leads");
  assert.equal(app.calls.length, 0);
});

test("queued, rejected and uncertain content deduplicate for exactly one day", async (t) => {
  for (const delivery of ["queued", "rejected", "uncertain"]) {
    await t.test(delivery, async (sub) => {
      const app = await fixture(sub, delivery === "queued" ? { telegramChatId: undefined } : {});
      app.setDelivery(() => delivery === "rejected" ? Response.json({ ok: false }) : Promise.reject(new Error("network")));
      assert.deepEqual((await app.submit()).body, { ok: true, delivery: "queued" });
      app.advance(DAY - 1);
      app.restart();
      assert.deepEqual((await app.submit()).body, { ok: true, delivery: "queued" });
      assert.equal(app.listLeads().length, 1);
      assert.equal(app.listLeads()[0].delivery, delivery);
      app.advance(1);
      assert.equal((await app.submit()).status, 200);
      assert.equal(app.listLeads().length, 2);
      assert.equal(app.calls.length, delivery === "queued" ? 0 : 2);
    });
  }
});

test("the first real operator is persisted and flushes queued leads only once across connections", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined, telegramBotToken: "123456:local-test-token" });
  const keyed = { headers: { "Idempotency-Key": "queued-once" } };
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "queued" });
  for (const user of [null, {}, { id: 0 }, { id: -1 }, { id: 1.5 }, { id: 123456 }, { id: 444, is_bot: true }]) {
    await app.bindOperator(user);
  }
  assert.equal(app.calls.length, 0);
  app.restart();
  const other = app.connect();
  const stalled = deferred();
  const entered = deferred();
  t.after(() => { stalled.resolve(success()); other.close(); });
  app.setDelivery(() => { entered.resolve(); return stalled.promise; });
  const binding = app.bindOperator({ id: 987654321, is_bot: false });
  await entered.promise;
  await other.bindOperator({ id: 111222333, is_bot: false });
  assert.equal(other.listLeads()[0].delivery, "uncertain");
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "queued" });
  assert.equal(app.calls.length, 1);
  stalled.resolve(success());
  await binding;
  assert.equal(app.listLeads()[0].delivery, "sent");
  assert.equal(String(JSON.parse(app.calls[0].options.body).chat_id), "987654321");
  app.restart();
  await app.bindOperator({ id: 222333444, is_bot: false });
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "sent" });
  assert.equal(app.calls.length, 1);
  app.advance(30_000);
  app.setDelivery(success);
  assert.deepEqual((await app.submit({ data: lead("После перезапуска") })).body, { ok: true, delivery: "sent" });
  assert.equal(String(JSON.parse(app.calls[1].options.body).chat_id), "987654321");
});

test("restart resumes the queued tail for a persisted operator without retrying an interrupted claim", { timeout: 5_000 }, async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  assert.deepEqual((await app.submit({ data: lead("Прерванная") })).body, { ok: true, delivery: "queued" });
  app.advance(30_000);
  assert.deepEqual((await app.submit({ data: lead("Хвост очереди") })).body, { ok: true, delivery: "queued" });
  const stalled = deferred();
  const entered = deferred();
  t.after(() => stalled.resolve(success()));
  app.setDelivery(() => {
    if (app.calls.length === 1) { entered.resolve(); return stalled.promise; }
    return success();
  });
  // Closing the first connection interrupts its result commit, just as process shutdown would.
  const interrupted = app.bindOperator({ id: 987654321, is_bot: false }).catch(() => {});
  await entered.promise;
  assert.deepEqual(app.listLeads().map(row => row.delivery), ["queued", "uncertain"]);
  app.restart();
  for (let attempt = 0; attempt < 100 && app.listLeads()[0].delivery !== "sent"; attempt++) {
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.deepEqual(app.listLeads().map(row => [row.name, row.delivery]), [
    ["Хвост очереди", "sent"], ["Прерванная", "uncertain"],
  ]);
  assert.equal(app.calls.length, 2, "Restart must deliver only the unclaimed queued tail without a new login");
  assert.match(JSON.parse(app.calls[1].options.body).text, /Хвост очереди/);
  assert.equal(String(JSON.parse(app.calls[1].options.body).chat_id), "987654321");
  stalled.resolve(success());
  await interrupted;
  app.restart();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(app.calls.length, 2);
  assert.deepEqual(app.listLeads().map(row => row.delivery), ["sent", "uncertain"]);
});

test("opening the database during an in-flight delivery cannot reclaim the durable attempt", async (t) => {
  const app = await fixture(t);
  const entered = deferred();
  const stalled = deferred();
  app.setDelivery(() => { entered.resolve(); return stalled.promise; });
  const keyed = { headers: { "Idempotency-Key": "claimed" } };
  const pending = app.submit(keyed);
  t.after(() => stalled.resolve(success()));
  await entered.promise;
  const reopened = app.connect();
  try {
    assert.equal(reopened.listLeads()[0].delivery, "uncertain");
    await reopened.bindOperator({ id: 987654321 });
    const response = await reopened.handle(new Request(`${origin}/api/lead`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json", ...keyed.headers },
      body: JSON.stringify(lead()),
    }), "203.0.113.1");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, delivery: "queued" });
    assert.equal(app.calls.length, 1);
    stalled.resolve(success());
    assert.deepEqual((await pending).body, { ok: true, delivery: "sent" });
    assert.equal(reopened.listLeads()[0].delivery, "sent");
  } finally { reopened.close(); }
  app.restart();
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "sent" });
  assert.equal(app.calls.length, 1);
});

test("configured chat takes precedence over operator binding", async (t) => {
  const app = await fixture(t);
  await app.bindOperator({ id: 987654321, is_bot: false });
  app.restart();
  assert.deepEqual((await app.submit()).body, { ok: true, delivery: "sent" });
  assert.equal(JSON.parse(app.calls[0].options.body).chat_id, app.config.telegramChatId);
});

test("failed durable insertion never accepts or delivers and rolls back the reservation", async (t) => {
  const app = await fixture(t);
  const db = new DatabaseSync(app.dbPath);
  try {
    db.exec("CREATE TRIGGER reject_lead BEFORE INSERT ON leads BEGIN SELECT RAISE(ABORT, 'test persistence failure'); END");
    const failed = await app.submit({ headers: { "Idempotency-Key": "persist-first" } });
    assert.equal(failed.status, 503);
    assert.equal(failed.body.ok, false);
    assert.equal(app.listLeads().length, 0);
    assert.equal(app.calls.length, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM reservations").get().count, 0);
    db.exec("DROP TRIGGER reject_lead");
    assert.deepEqual((await app.submit({ headers: { "Idempotency-Key": "persist-first" } })).body, { ok: true, delivery: "sent" });
    assert.equal(app.calls.length, 1);
  } finally { db.close(); }
});

test("an interrupted delivery-state commit leaves a non-retryable claim across restart", async (t) => {
  const app = await fixture(t);
  const db = new DatabaseSync(app.dbPath);
  const keyed = { headers: { "Idempotency-Key": "commit-interrupted" } };
  try {
    db.exec("CREATE TRIGGER reject_completion BEFORE UPDATE ON leads WHEN NEW.delivery='sent' BEGIN SELECT RAISE(ABORT, 'test completion failure'); END");
    const accepted = await app.submit(keyed);
    assert.equal(accepted.status, 200);
    assert.deepEqual(accepted.body, { ok: true, delivery: "queued" });
    assert.equal(app.listLeads()[0].delivery, "uncertain");
    assert.equal(app.calls.length, 1);
    db.exec("DROP TRIGGER reject_completion");
  } finally { db.close(); }
  app.restart();
  await app.bindOperator({ id: 987654321 });
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "queued" });
  assert.equal(app.listLeads()[0].delivery, "uncertain");
  assert.equal(app.calls.length, 1, "A delivered message whose result could not be committed must not be sent again");
});

test("a queued lead still requires origin and Turnstile validation but a saved keyed replay needs no new token", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined, turnstileSecret: "local-turnstile-secret" });
  assert.equal((await app.submit({ requestOrigin: null })).status, 403);
  assert.equal((await app.submit({ requestOrigin: origin + ".evil" })).status, 403);
  assert.equal((await app.submit()).status, 403);
  assert.equal(app.listLeads().length, 0);
  assert.equal(app.calls.length, 0);
  const keyed = { headers: { "Idempotency-Key": "verified-queue" } };
  assert.deepEqual((await app.submit({ ...keyed, data: { ...lead(), turnstileToken: "one-time-token" } })).body,
    { ok: true, delivery: "queued" });
  app.restart();
  app.setTurnstile(() => Response.json({ success: false }));
  assert.deepEqual((await app.submit(keyed)).body, { ok: true, delivery: "queued" });
  assert.equal(app.calls.length, 1);
  assert.match(app.calls[0].url, /siteverify$/);
  assert.equal(app.listLeads().length, 1);
});

test("legacy reservations without durable lead fields never claim successful acceptance or resend", async (t) => {
  for (const state of ["pending", "confirmed", "rejected", "uncertain"]) {
    await t.test(state, async (sub) => {
      const app = await fixture(sub);
      const hash = value => createHmac("sha256", secret).update(value).digest("hex");
      const ipHash = hash("ip:203.0.113.1");
      const contentHash = hash(`lead:${JSON.stringify([lead().name, "79212345678", "", ""])}`);
      const db = new DatabaseSync(app.dbPath);
      try {
        db.prepare("INSERT INTO reservations(id,ip_hash,content_hash,created_at,state) VALUES (1,?,?,?,?)")
          .run(ipHash, contentHash, 1_000_000, state);
        db.prepare("INSERT INTO request_keys(key_hash,content_hash,reservation_id,created_at) VALUES (?,?,1,?)")
          .run(hash(`key:${ipHash}:legacy-key`), contentHash, 1_000_000);
      } finally { db.close(); }
      app.restart();
      for (const headers of [{ "Idempotency-Key": "legacy-key" }, {}]) {
        const response = await app.submit({ headers });
        assert.equal(response.status, 409);
        assert.equal(response.body.ok, false);
      }
      assert.deepEqual(app.listLeads(), []);
      assert.equal(app.calls.length, 0);
    });
  }
});

test("queued leads retain the per-IP daily limit across restart", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  for (let i = 0; i < 3; i++) {
    const response = await app.submit({ data: lead(`В очереди ${i}`) });
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { ok: true, delivery: "queued" });
    app.advance(30_000);
  }
  app.restart();
  assert.equal((await app.submit({ data: lead("Четвертая") })).status, 429);
  assert.equal(app.listLeads().length, 3);
  assert.equal(app.calls.length, 0);
});

test("field type and length limits still apply before persistence without a recipient", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  for (const data of [null, [], {}, { ...lead(), name: " " }, { ...lead(), name: 123 },
    { ...lead(), name: "я".repeat(101) }, { ...lead(), object: null }, { ...lead(), object: "я".repeat(201) },
    { ...lead(), location: 123 }, { ...lead(), location: "я".repeat(201) }]) {
    assert.equal((await app.submit({ data })).status, 400);
  }
  assert.equal(app.listLeads().length, 0);
  assert.deepEqual((await app.submit({ data: { ...lead("я".repeat(100)), object: "я".repeat(200), location: "я".repeat(200) } })).body,
    { ok: true, delivery: "queued" });
  assert.equal(app.listLeads().length, 1);
  assert.equal(app.calls.length, 0);
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

test("leads deliver to all authenticated operators when multiple operators have bound", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  await app.bindOperator({ id: 1001, is_bot: false });
  await app.bindOperator({ id: 2002, is_bot: false });
  await app.bindOperator({ id: 3003, is_bot: false });
  const response = await app.submit({ data: lead("Рассылка всем") });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, delivery: "sent" });
  assert.equal(app.calls.length, 3);
  const chats = app.calls.map(c => JSON.parse(c.options.body).chat_id).sort();
  assert.deepEqual(chats, ["1001", "2002", "3003"]);
  assert.equal(app.listLeads()[0].delivery, "sent");
});

test("delivery to operator A succeeds even if operator B returns 4xx rejection", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  await app.bindOperator({ id: 1001, is_bot: false });
  await app.bindOperator({ id: 2002, is_bot: false });
  app.setDelivery((_, options) => {
    const body = JSON.parse(options.body);
    if (body.chat_id === "2002") return new Response('{"ok":false,"description":"Forbidden: bot was blocked by the user"}', { status: 403 });
    return success();
  });
  const response = await app.submit({ data: lead("Один заблокирован") });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, delivery: "sent" });
  assert.equal(app.calls.length, 2);
  assert.equal(app.listLeads()[0].delivery, "sent");
});

test("queued leads waiting without recipients are sent to the newly bound operator", async (t) => {
  const app = await fixture(t, { telegramChatId: undefined });
  const response = await app.submit({ data: lead("Ожидающая заявка") });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true, delivery: "queued" });
  assert.equal(app.calls.length, 0);
  await app.bindOperator({ id: 5555, is_bot: false });
  assert.equal(app.calls.length, 1);
  assert.equal(JSON.parse(app.calls[0].options.body).chat_id, "5555");
  assert.equal(app.listLeads()[0].delivery, "sent");
});

test("legacy lead_recipient table is transparently migrated to lead_recipients", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "remgaz-legacy-"));
  const dbPath = join(dir, "lead.sqlite");
  t.after(async () => { await rm(dir, { recursive: true, force: true }); });
  const legacyDb = new DatabaseSync(dbPath);
  legacyDb.exec(`
    CREATE TABLE lead_recipient (id INTEGER PRIMARY KEY CHECK (id=1), chat_id TEXT NOT NULL);
    INSERT INTO lead_recipient (id, chat_id) VALUES (1, '99999');
  `);
  legacyDb.close();
  const calls = [];
  const service = createLeadService({
    origin, dbPath, ipHashSecret: secret,
    telegramBotToken: "local-test-token", telegramChatId: undefined,
    fetch: (url, options) => { calls.push({ url, options }); return success(); },
  });
  t.after(() => { service.close(); });
  const request = new Request(`${origin}/api/lead`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(lead("Миграция")),
  });
  const response = await service.handle(request, "203.0.113.1");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, delivery: "sent" });
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].options.body).chat_id, "99999");
});
