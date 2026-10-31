import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, SourceTextModule, SyntheticModule } from "node:vm";

const DAY_MS = 24 * 60 * 60 * 1000;
const WORKER_URL = new URL("./lead.js", import.meta.url);
const phoneCases = JSON.parse(await readFile(new URL("./phone-cases.json", import.meta.url), "utf8"));
const source = await readFile(WORKER_URL, "utf8");
const origin = "https://salewam.github.io";
const success = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  let now = 0;
  let delivery = success;
  let globalLimit = () => ({ success: true });
  let globalChecks = 0;
  let storageReads = 0;
  let storageFailure = null;
  let nextTimer = 0;
  const telegramWaiters = [];
  const timers = new Map();
  const telegramCalls = [];
  const storageMap = new Map();
  const objects = new Map();
  const context = createContext({
    AbortController,
    Date: class extends Date {
      static now() { return now; }
    },
    Response,
    URL,
    TextDecoder,
    setTimeout: (fn, ms) => {
      assert.equal(ms, 8000);
      const id = ++nextTimer;
      timers.set(id, fn);
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    fetch: async (url, options) => {
      const index = telegramCalls.push({ url, options }) - 1;
      for (const waiter of telegramWaiters.splice(0)) waiter();
      return delivery(index);
    },
  });
  const module = new SourceTextModule(source, { context, identifier: fileURLToPath(WORKER_URL) });
  await module.link((specifier) => {
    assert.equal(specifier, "cloudflare:workers");
    return new SyntheticModule(["DurableObject"], function () {
      this.setExport("DurableObject", class {
        constructor(ctx, env) {
          this.ctx = ctx;
          this.env = env;
        }
      });
    }, { context });
  });
  await module.evaluate();

  const env = {
    TELEGRAM_BOT_TOKEN: "local-test-token",
    TELEGRAM_CHAT_ID: "local-test-chat",
    LEAD_GLOBAL_LIMIT: {
      async limit() {
        globalChecks++;
        return globalLimit();
      },
    },
  };
  env.LEAD_VISITOR_GUARD = {
    idFromName: (ip) => ip,
    get(ip) {
      if (!objects.has(ip)) {
        if (!storageMap.has(ip)) storageMap.set(ip, { values: new Map(), alarmAt: null });
        const state = storageMap.get(ip);
        const storage = {
          async get(key) {
            storageReads++;
            if (storageFailure === "get") throw new Error("storage get failed");
            return state.values.get(key);
          },
          async put(key, value) {
            if (storageFailure === "put") throw new Error("storage put failed");
            state.values.set(key, value);
          },
          async setAlarm(time) {
            if (storageFailure === "setAlarm") throw new Error("storage alarm failed");
            state.alarmAt = time;
          },
          async deleteAll() {
            if (storageFailure === "deleteAll") throw new Error("storage deletion failed");
            state.values.clear();
            state.alarmAt = null;
          },
        };
        objects.set(ip, new module.namespace.LeadVisitorGuard({ storage }, env));
      }
      return objects.get(ip);
    },
  };

  return {
    telegramCalls,
    storageMap,
    get storageReads() { return storageReads; },
    get globalChecks() { return globalChecks; },
    get activeTimers() { return timers.size; },
    setTime(time) { now = time; },
    restart() { objects.clear(); },
    setDelivery(fn) { delivery = fn; },
    setGlobalLimit(fn) { globalLimit = fn; },
    setStorageFailure(operation) { storageFailure = operation; },
    waitForTelegram(count = 1) {
      if (telegramCalls.length >= count) return Promise.resolve();
      return new Promise((resolve) => telegramWaiters.push(resolve));
    },
    fireTimers() {
      for (const [id, fn] of timers) {
        timers.delete(id);
        fn();
      }
    },
    alarm(ip = "203.0.113.1") { return env.LEAD_VISITOR_GUARD.get(ip).alarm(); },
    async raw({ path = "/lead", method = "POST", requestOrigin = origin, contentType = "application/json", ip = "203.0.113.1", body, headers = {} } = {}) {
      const requestHeaders = { ...headers };
      if (requestOrigin !== null) requestHeaders.Origin = requestOrigin;
      if (contentType !== null) requestHeaders["Content-Type"] = contentType;
      if (ip !== null) requestHeaders["CF-Connecting-IP"] = ip;
      const request = new Request(`https://example.workers.dev${path}`, {
        method, headers: requestHeaders, ...(body === undefined ? {} : { body }),
      });
      const response = await module.namespace.default.fetch(request, env);
      return { status: response.status, body: response.status === 204 ? null : await response.json(), headers: response.headers };
    },
    async submit({ ip = "203.0.113.1", phone = "+7 (812) 385-53-53", ...fields } = {}) {
      return this.raw({ ip, body: JSON.stringify({ name: "Тест", phone, ...fields }) });
    },
  };
}

test("ten concurrent requests from one IP deliver three, then reject seven before the global limiter", async () => {
  const app = await fixture();
  const results = await Promise.all(Array.from({ length: 10 }, () => app.submit()));
  assert.deepEqual(results.map(({ status }) => status).sort(), [200, 200, 200, 429, 429, 429, 429, 429, 429, 429]);
  assert.equal(app.telegramCalls.length, 3);
  assert.equal(app.globalChecks, 3);
  assert.equal((await app.submit({ ip: "198.51.100.2" })).status, 200);
  assert.equal(app.telegramCalls.length, 4);
});

test("rolling 24-hour boundary and storage survive Durable Object reinitialization", async () => {
  const app = await fixture();
  for (const time of [0, 1, 2]) {
    app.setTime(time);
    assert.equal((await app.submit()).status, 200);
  }
  app.restart();
  app.setTime(DAY_MS - 1);
  assert.equal((await app.submit()).status, 429);
  app.setTime(DAY_MS);
  assert.equal((await app.submit()).status, 200);
  assert.equal(app.storageMap.get("203.0.113.1").values.get("submissions").length, 3);
  app.restart();
  assert.equal((await app.submit()).status, 429);
  assert.equal(app.telegramCalls.length, 4);
});

test("shared phone cases enforce the same acceptance boundary at the Worker", async () => {
  const app = await fixture();
  let accepted = 0;
  for (const { phone, valid } of phoneCases) {
    const response = await app.submit({ ip: `198.51.100.${accepted + 1}`, phone });
    assert.equal(response.status, valid ? 200 : 400, JSON.stringify(phone));
    if (valid) accepted++;
  }
  for (const phone of [null, 79212345678, { value: "79212345678" }]) {
    assert.equal((await app.submit({ phone })).status, 400);
  }
  assert.equal(app.telegramCalls.length, accepted);
});

test("explicit Telegram 4xx and ok:false release the visitor slot", async (t) => {
  for (const [name, response] of [
    ["HTTP 400", () => new Response("rejected", { status: 400 })],
    ["API ok:false", () => new Response(JSON.stringify({ ok: false }), { status: 200 })],
  ]) {
    await t.test(name, async () => {
      const app = await fixture();
      app.setDelivery((index) => index === 0 ? response() : success());
      assert.equal((await app.submit()).status, 502);
      for (let i = 0; i < 3; i++) assert.equal((await app.submit()).status, 200);
      assert.equal((await app.submit()).status, 429);
      assert.equal(app.telegramCalls.length, 4);
    });
  }
});

test("ambiguous Telegram outcomes keep reserved slots and never claim success", async (t) => {
  for (const [name, response] of [
    ["HTTP 500", () => new Response("upstream error", { status: 500 })],
    ["malformed JSON", () => new Response("{", { status: 200 })],
    ["missing ok", () => new Response("{}", { status: 200 })],
    ["network error", () => Promise.reject(new Error("connection lost"))],
  ]) {
    await t.test(name, async () => {
      const app = await fixture();
      app.setDelivery(response);
      for (let i = 0; i < 3; i++) {
        const result = await app.submit();
        assert.equal(result.status, 502);
        assert.equal(result.body.ok, false);
      }
      assert.equal((await app.submit()).status, 429);
      assert.equal(app.telegramCalls.length, 3);
      assert.equal(app.globalChecks, 3);
    });
  }
});

test("deadline aborts a stalled fetch and retains the reservation despite a late success", async () => {
  const app = await fixture();
  const stalled = deferred();
  app.setDelivery((index) => index === 0 ? stalled.promise : success());
  const submission = app.submit();
  await app.waitForTelegram();
  assert.equal(app.activeTimers, 1);
  assert.equal(app.telegramCalls[0].options.signal.aborted, false);
  app.fireTimers();
  assert.equal((await submission).status, 502);
  assert.equal(app.telegramCalls[0].options.signal.aborted, true);
  assert.equal(app.activeTimers, 0);
  stalled.resolve(success());
  await Promise.resolve();
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 429);
  assert.equal(app.telegramCalls.length, 3);
});

test("deadline includes a stalled Telegram JSON body; a late rejection cannot release a slot", async () => {
  const app = await fixture();
  const stalledBody = deferred();
  app.setDelivery((index) => index === 0 ? { ok: true, json: () => stalledBody.promise } : success());
  const submission = app.submit();
  await app.waitForTelegram();
  assert.equal(app.activeTimers, 1);
  app.fireTimers();
  assert.equal((await submission).status, 502);
  assert.equal(app.telegramCalls[0].options.signal.aborted, true);
  stalledBody.resolve({ ok: false });
  await Promise.resolve();
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 429);
  assert.equal(app.telegramCalls.length, 3);
});

test("global limiter refusal and failure do not send or reserve a visitor slot", async (t) => {
  for (const [name, limit, status] of [
    ["refusal", () => ({ success: false }), 429],
    ["failure", () => { throw new Error("limiter unavailable"); }, 503],
  ]) {
    await t.test(name, async () => {
      const app = await fixture();
      app.setGlobalLimit(limit);
      assert.equal((await app.submit()).status, status);
      assert.equal(app.telegramCalls.length, 0);
      assert.equal(app.storageMap.get("203.0.113.1").values.has("submissions"), false);
      app.setGlobalLimit(() => ({ success: true }));
      for (let i = 0; i < 3; i++) assert.equal((await app.submit()).status, 200);
      assert.equal((await app.submit()).status, 429);
    });
  }
});

test("storage failures before and after reservation fail closed without sending", async (t) => {
  for (const operation of ["get", "put", "setAlarm"]) {
    await t.test(operation, async () => {
      const app = await fixture();
      app.setStorageFailure(operation);
      assert.equal((await app.submit()).status, 503);
      assert.equal(app.telegramCalls.length, 0);
      const state = app.storageMap.get("203.0.113.1");
      assert.deepEqual(Array.from(state.values.get("submissions") ?? []), operation === "setAlarm" ? [0] : []);
      app.setStorageFailure(null);
      const remaining = operation === "setAlarm" ? 2 : 3;
      for (let i = 0; i < remaining; i++) assert.equal((await app.submit()).status, 200);
      assert.equal((await app.submit()).status, 429);
    });
  }
});

test("failed storage write after confirmed Telegram rejection keeps the reserved slot", async () => {
  const app = await fixture();
  app.setDelivery((index) => {
    if (index === 0) {
      app.setStorageFailure("put");
      return new Response("rejected", { status: 400 });
    }
    return success();
  });
  assert.equal((await app.submit()).status, 502);
  assert.deepEqual(Array.from(app.storageMap.get("203.0.113.1").values.get("submissions")), [0]);
  app.setStorageFailure(null);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 429);
  assert.equal(app.telegramCalls.length, 3);
});

test("alarm waits for in-flight delivery and removes expired slots without losing fresh ones", async () => {
  const app = await fixture();
  assert.equal((await app.submit()).status, 200);
  app.setTime(DAY_MS);
  const blocked = deferred();
  app.setDelivery((index) => index === 1 ? blocked.promise : success());
  const submission = app.submit();
  await app.waitForTelegram(2);
  const reads = app.storageReads;
  const cleanup = app.alarm();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  assert.equal(app.storageReads, reads);
  blocked.resolve(success());
  assert.equal((await submission).status, 200);
  await cleanup;
  assert.deepEqual(Array.from(app.storageMap.get("203.0.113.1").values.get("submissions")), [DAY_MS]);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 429);
});

test("empty alarm cleanup cannot erase a fresh request queued behind it", async () => {
  const app = await fixture();
  assert.equal((await app.submit()).status, 200);
  app.setTime(DAY_MS);
  const cleanup = app.alarm();
  const fresh = app.submit();
  await cleanup;
  assert.equal((await fresh).status, 200);
  assert.deepEqual(Array.from(app.storageMap.get("203.0.113.1").values.get("submissions")), [DAY_MS]);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 200);
  assert.equal((await app.submit()).status, 429);
});

test("HTTP routing, Origin, preflight, and content type reject untrusted requests before quota", async () => {
  const app = await fixture();
  const body = JSON.stringify({ name: "Тест", phone: "1234567890" });
  for (const [options, status] of [
    [{ path: "/other", body }, 404],
    [{ requestOrigin: null, body }, 403],
    [{ requestOrigin: "https://attacker.example", body }, 403],
    [{ method: "GET" }, 405],
    [{ method: "OPTIONS", headers: { "Access-Control-Request-Method": "GET" } }, 405],
    [{ contentType: null, body }, 415],
    [{ contentType: "text/plain", body }, 415],
    [{ contentType: "application/json; charset=iso-8859-1", body }, 415],
  ]) {
    const result = await app.raw(options);
    assert.equal(result.status, status, JSON.stringify(options));
    assert.equal(result.body.ok, false);
  }
  const preflight = await app.raw({ method: "OPTIONS", headers: { "Access-Control-Request-Method": "POST" } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal(app.globalChecks, 0);
  assert.equal(app.telegramCalls.length, 0);
  assert.equal((await app.raw({ contentType: "APPLICATION/JSON; charset=UTF-8", body })).status, 200);
});

test("body is strict JSON and UTF-8 with a 4096-byte cap, independent of Content-Length", async () => {
  const app = await fixture();
  const valid = JSON.stringify({ name: "Тест", phone: "1234567890" });
  const atLimit = valid + " ".repeat(4096 - Buffer.byteLength(valid, "utf8"));
  const aboveLimit = atLimit + " ";
  assert.equal(Buffer.byteLength(atLimit, "utf8"), 4096);
  assert.equal(Buffer.byteLength(aboveLimit, "utf8"), 4097);
  for (const [body, expected] of [
    [undefined, 400], ["", 400], ["{", 400], ["null", 400], ["[]", 400],
    [new Uint8Array([123, 34, 110, 97, 109, 101, 34, 58, 34, 255, 34, 125]), 400],
    [aboveLimit, 413],
    [JSON.stringify({ name: "é".repeat(2100), phone: "1234567890" }), 413],
  ]) {
    assert.equal((await app.raw({ body })).status, expected);
  }
  assert.equal((await app.raw({ body: valid, headers: { "Content-Length": "4097" } })).status, 413);
  assert.equal(app.telegramCalls.length, 0);
  assert.equal(app.globalChecks, 0);
  assert.equal((await app.raw({ body: atLimit })).status, 200);
});

test("field boundaries, honeypot, missing trusted IP and spoofed fields never reset quota", async () => {
  const app = await fixture();
  const badFields = [
    { name: "   " }, { name: "x".repeat(101) }, { name: 12 },
    { object: "x".repeat(201) }, { location: "x".repeat(201) },
    { object: null }, { location: { city: "Москва" } },
    { website: "https://spam.example" }, { website: 12 },
  ];
  for (const fields of badFields) assert.equal((await app.submit(fields)).status, 400);
  assert.equal((await app.submit({ ip: null })).status, 503);
  assert.equal(app.telegramCalls.length, 0);
  assert.equal(app.globalChecks, 0);
  for (let i = 0; i < 3; i++) {
    const payload = { name: "  Тест  ", phone: "1234567890", website: "   ", object: "  Котельная  ", fakeIp: `198.51.100.${i + 1}` };
    const result = await app.raw({ body: JSON.stringify(payload), headers: { "X-Forwarded-For": `198.51.100.${i + 1}` } });
    assert.equal(result.status, 200);
  }
  assert.equal((await app.raw({ body: JSON.stringify({ name: "Тест", phone: "1234567890", ip: "198.51.100.99" }), headers: { "X-Forwarded-For": "198.51.100.99" } })).status, 429);
  assert.equal(app.telegramCalls.length, 3);
  assert.match(JSON.parse(app.telegramCalls[0].options.body).text, /Имя: Тест\nТелефон: 1234567890\nОбъект: Котельная/);
});
