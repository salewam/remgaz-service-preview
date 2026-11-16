import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { webcrypto } from 'node:crypto';

const script = readFileSync(new URL('./form.js', import.meta.url), 'utf8');
const phoneCases = JSON.parse(readFileSync(new URL('../server/phone-cases.json', import.meta.url), 'utf8'));
const pages = ['index.html', 'gas.html'];

function attribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'u'))?.[1];
}

function makePage(page, options = {}) {
  const html = options.html || readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
  const markup = html.match(/<form\b[^>]*class="editorial-form"[^>]*>[\s\S]*?<\/form>/u)?.[0];
  assert.ok(markup, `${page}: editorial form exists`);
  const tag = markup.match(/^<form\b[^>]*>/u)[0];
  assert.equal(attribute(tag, 'onsubmit'), 'submitLead(event)');
  assert.equal(attribute(tag, 'action'), '/api/lead');
  assert.match(markup, /data-form-status\s+role="status"\s+aria-live="polite"/u);
  const elements = {};
  for (const [inputTag] of markup.matchAll(/<input\b[^>]*>/gu)) {
    const name = attribute(inputTag, 'name');
    if (!name) continue;
    const listeners = new Map();
    const pattern = attribute(inputTag, 'pattern');
    const matchesPattern = pattern && new RegExp(`^(?:${pattern})$`, 'v');
    const input = {
      value: '',
      required: /\srequired(?=\s|>)/u.test(inputTag),
      maxLength: Number(attribute(inputTag, 'maxlength') ?? -1),
      matchesPattern,
      customError: '',
      invalidCount: 0,
      reportValidityCount: 0,
      setCustomValidity(message) { this.customError = message; },
      addEventListener(type, listener) {
        if (!listeners.has(type)) listeners.set(type, []);
        listeners.get(type).push(listener);
      },
      dispatch(type) {
        for (const listener of listeners.get(type) || []) listener({ currentTarget: this });
      },
      input(value) { this.value = value; this.dispatch('input'); },
      reportValidity() {
        // Programmatically assigned values do not trigger native tooLong.
        const valid = !this.customError && (!this.required || this.value !== '')
          && (!this.value || !this.matchesPattern || this.matchesPattern.test(this.value));
        this.reportValidityCount++;
        if (!valid) { this.invalidCount++; this.dispatch('invalid'); }
        return valid;
      },
    };
    Object.defineProperty(input, 'validity', { get: () => ({ customError: !!input.customError }) });
    elements[name] = input;
  }
  const button = { disabled: false, textContent: 'Оставить заявку' };
  const status = { textContent: '' };
  const form = {
    elements,
    querySelector(selector) {
      if (selector === 'button[type="submit"]') return button;
      if (selector === '[data-form-status]') return status;
      return null;
    },
    reportValidity() {
      return Object.values(elements).map(input => input.reportValidity()).every(Boolean);
    },
  };
  const navigations = [];
  const requests = [];
  const baseURI = options.url || `https://remgaz.example.test/${page}`;
  let href = baseURI;
  const window = { location: {
    get href() { return href; },
    set href(value) { href = value; navigations.push(value); },
  } };
  const apiTag = html.match(/<meta\b[^>]*name="remgaz-content-api"[^>]*>/u)?.[0];
  const context = createContext({
    document: {
      baseURI,
      querySelector: () => apiTag ? { content: attribute(apiTag, 'content') } : null,
      querySelectorAll: () => [form]
    },
    window, URL, crypto: webcrypto,
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return options.fetch ? options.fetch(url, init) : { ok: true, json: async () => ({ ok: true, delivery: 'queued' }) };
    }
  });
  runInContext(options.script || script, context, { filename: 'assets/form.js' });
  function directSubmit() {
    let prevented = false;
    const pending = context.submitLead({ currentTarget: form, preventDefault() { prevented = true; } });
    assert.ok(prevented);
    return pending;
  }
  function submit() {
    if (form.reportValidity()) return directSubmit();
  }
  return { elements, form, context, window, navigations, requests, button, status, directSubmit, submit };
}

for (const page of pages) {
  test(`${page}: server phone cases agree with executed JS and native v-pattern`, () => {
    const { elements, context } = makePage(page);
    assert.equal(elements.name.required, true);
    assert.equal(elements.name.maxLength, 100);
    assert.equal(elements.phone.required, true);
    assert.equal(elements.phone.maxLength, 40);
    assert.equal(elements.object.maxLength, 200);
    assert.equal(elements.location.maxLength, 200);
    assert.equal(elements.location.required, page === 'gas.html');
    assert.ok(elements.phone.matchesPattern);
    for (const { phone, valid } of phoneCases) {
      elements.phone.value = phone;
      assert.equal(context.validatePhone(elements.phone), valid, `${page}: JS phone ${JSON.stringify(phone)}`);
      assert.equal(!!phone && elements.phone.matchesPattern.test(phone), valid, `${page}: HTML phone ${JSON.stringify(phone)}`);
    }
  });

  test(`${page}: native required blocks an empty name; direct handler also guards an empty phone`, async () => {
    const view = makePage(page);
    view.elements.phone.value = '79212345678';
    view.elements.location.value = 'СПб';
    await view.submit();
    assert.ok(view.elements.name.invalidCount);
    assert.equal(view.requests.length, 0);
    view.elements.name.input('Анна');
    view.elements.phone.value = '';
    await view.directSubmit();
    assert.ok(view.elements.phone.customError);
    assert.equal(view.requests.length, 0);
    view.elements.phone.input('79212345678');
    await view.submit();
    assert.equal(view.requests.length, 1);
  });

  test(`${page}: whitespace-only name blocks submission and correction clears the error`, async () => {
    const view = makePage(page);
    const { name, phone, location } = view.elements;
    name.value = ' \t ';
    phone.value = '+7 (921) 234-56-78';
    location.value = 'Санкт-Петербург';
    await view.submit();
    assert.match(name.customError, /имя/u);
    assert.equal(view.requests.length, 0);
    name.input('Анна');
    assert.equal(name.customError, '');
    await view.submit();
    assert.equal(view.requests.length, 1);
  });

  test(`${page}: leaving empty or partial phone via blur does not report validity or trap focus; submission still validates`, async () => {
    const view = makePage(page);
    const { name, phone, location } = view.elements;

    // Leaving empty phone does not trigger reportValidity or trap user
    phone.dispatch('blur');
    assert.equal(phone.reportValidityCount, 0);
    assert.equal(phone.customError, '');
    assert.equal(view.requests.length, 0);

    // User can focus and edit name while phone is empty
    name.input('Анна');
    assert.equal(name.value, 'Анна');
    assert.equal(name.customError, '');

    // Typing partial/incomplete phone and leaving to another field does not trigger reportValidity
    phone.input('+7 (9');
    phone.dispatch('blur');
    assert.equal(phone.reportValidityCount, 0);
    assert.equal(phone.customError, '');
    assert.equal(view.requests.length, 0);

    // User can still edit location/object without premature validity errors
    location.input('Санкт-Петербург');
    assert.equal(location.value, 'Санкт-Петербург');

    // Actual submit with incomplete phone triggers validation and blocks request
    await view.submit();
    assert.ok(phone.invalidCount);
    assert.ok(phone.customError);
    assert.equal(view.requests.length, 0);

    // Correcting phone clears error and allows successful submission
    phone.input('+7 (921) 234-56-78');
    assert.equal(phone.customError, '');
    phone.dispatch('blur');
    assert.equal(phone.customError, '');
    await view.submit();
    assert.equal(view.requests.length, 1);
  });

  test(`${page}: direct handler validates programmatic maxlength and required values`, async () => {
    const view = makePage(page);
    const { name, phone, object, location } = view.elements;
    name.value = 'Анна';
    phone.value = '1-2-3-4-5-6-7-8-9-0-1-2-3-4-5-6-7-8-9-0-1';
    location.value = 'СПб';
    await view.directSubmit();
    assert.match(phone.customError, /40/u);
    assert.equal(view.requests.length, 0);
    phone.input('79212345678');
    name.value = 'А'.repeat(101);
    await view.directSubmit();
    assert.match(name.customError, /100/u);
    assert.equal(view.requests.length, 0);
    name.input('Анна');
    object.value = 'Д'.repeat(201);
    await view.directSubmit();
    assert.match(object.customError, /200/u);
    assert.equal(view.requests.length, 0);
    object.input('Дом');
    location.value = 'М'.repeat(201);
    await view.directSubmit();
    assert.match(location.customError, /200/u);
    assert.equal(view.requests.length, 0);
    location.input('СПб');
    await view.submit();
    assert.equal(view.requests.length, 1);
  });

  test(`${page}: sends every field directly to the API without opening email`, async () => {
    const view = makePage(page);
    view.elements.name.value = ' Анна & Борис? ';
    view.elements.phone.value = ' +7 (921) 234-56-78 ';
    view.elements.object.value = ' Дом & газ\nСУГ ';
    view.elements.location.value = ' СПб? A&B ';
    await view.submit();
    assert.equal(view.requests.length, 1);
    const { url, init } = view.requests[0];
    assert.equal(url, 'https://remgaz.example.test/api/lead');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(init.body), {
      name: 'Анна & Борис?', phone: '+7 (921) 234-56-78', object: 'Дом & газ\nСУГ', location: 'СПб? A&B'
    });
    assert.match(view.status.textContent, /^Заявка принята и сохранена/u);
    assert.doesNotMatch(view.status.textContent, /уведомление отправлено|доставлена в Telegram/iu);
    assert.match(init.headers['Idempotency-Key'], /^[a-f0-9-]{36}$/u);
    assert.equal(view.navigations.length, 0);
    assert.equal(view.button.disabled, false);
    assert.equal(view.button.textContent, 'Оставить заявку');
  });

  test(`${page}: Pages uses the configured backend, not github.io/api/lead`, async () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
      .replace('content="/api/content"', 'content="https://api.example.test/api/content"');
    const view = makePage(page, { html, url: `https://salewam.github.io/remgaz-service-preview/${page}` });
    view.elements.name.value = 'Анна';
    view.elements.phone.value = '79212345678';
    view.elements.location.value = 'СПб';
    await view.submit();
    assert.equal(view.requests[0].url, 'https://api.example.test/api/lead');
    assert.match(view.status.textContent, /^Заявка принята и сохранена/u);
  });

  test(`${page}: repeated submit while sending makes only one request and waits for confirmation`, async () => {
    let complete;
    const view = makePage(page, { fetch: () => new Promise(resolve => { complete = resolve; }) });
    view.elements.name.value = 'Анна';
    view.elements.phone.value = '79212345678';
    view.elements.location.value = 'СПб';
    const pending = view.submit();
    assert.equal(view.button.disabled, true);
    assert.match(view.status.textContent, /Отправляем/u);
    await view.directSubmit();
    assert.equal(view.requests.length, 1);
    complete({ ok: true, json: async () => ({ ok: true, delivery: 'sent' }) });
    await pending;
    assert.equal(view.button.disabled, false);
    assert.match(view.status.textContent, /^Заявка принята и сохранена/u);
  });

  test(`${page}: retries keep the same idempotency key, changing fields makes a new request`, async () => {
    let fail = true;
    const view = makePage(page, { fetch: async () => {
      if (fail) { fail = false; throw new Error('Response lost'); }
      return { ok: true, json: async () => ({ ok: true, delivery: 'queued' }) };
    } });
    view.elements.name.value = 'Анна';
    view.elements.phone.value = '79212345678';
    view.elements.location.value = 'СПб';
    await view.submit();
    assert.doesNotMatch(view.status.textContent, /^Заявка принята/u);
    await view.submit();
    assert.match(view.status.textContent, /^Заявка принята и сохранена/u);
    await view.submit();
    const keys = view.requests.map(request => request.init.headers['Idempotency-Key']);
    assert.equal(keys[0], keys[1]);
    assert.equal(keys[1], keys[2]);
    view.elements.object.value = 'Другой объект';
    await view.submit();
    assert.notEqual(view.requests[3].init.headers['Idempotency-Key'], keys[0]);
  });

  test(`${page}: rejection or network failure keeps the values and never claims success`, async () => {
    for (const fetch of [
      async () => ({ ok: false, json: async () => ({ ok: false, error: 'Не удалось отправить заявку' }) }),
      async () => ({ ok: true, json: async () => ({ ok: false, error: 'Статус отправки неизвестен' }) }),
      async () => ({ ok: false, json: async () => ({ ok: true }) }),
      async () => ({ ok: true, json: async () => ({ ok: true }) }),
      async () => ({ ok: true, json: async () => ({ ok: true, delivery: 'uncertain' }) }),
      async () => { throw new Error('Offline'); },
      async () => ({ ok: true, json: async () => { throw new Error('Not JSON'); } })
    ]) {
      const view = makePage(page, { fetch });
      view.elements.name.value = 'Анна';
      view.elements.phone.value = '79212345678';
      view.elements.location.value = 'СПб';
      await view.submit();
      assert.doesNotMatch(view.status.textContent, /^Заявка принята/u);
      assert.ok(view.status.textContent);
      assert.equal(view.elements.name.value, 'Анна');
      assert.equal(view.elements.phone.value, '79212345678');
      assert.equal(view.elements.location.value, 'СПб');
      assert.equal(view.button.disabled, false);
      assert.equal(view.navigations.length, 0);
    }
  });
}

test('gas.html: a whitespace-only required delivery address blocks even direct submission', async () => {
  const view = makePage('gas.html');
  view.elements.name.value = 'Анна';
  view.elements.phone.value = '79212345678';
  view.elements.location.value = ' \t ';
  await view.directSubmit();
  assert.ok(view.elements.location.customError);
  assert.equal(view.requests.length, 0);
  view.elements.location.input('СПб');
  assert.equal(view.elements.location.customError, '');
  await view.submit();
  assert.equal(view.requests.length, 1);
});
