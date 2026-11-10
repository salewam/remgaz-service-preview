import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const script = readFileSync(new URL('./form.js', import.meta.url), 'utf8');
const phoneCases = JSON.parse(readFileSync(new URL('../server/phone-cases.json', import.meta.url), 'utf8'));
const pages = ['index.html', 'gas.html'];

function attribute(tag, name) {
  return tag.match(new RegExp(`\\s${name}="([^"]*)"`, 'u'))?.[1];
}

function makePage(page) {
  const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
  const markup = html.match(/<form\b[^>]*class="editorial-form"[^>]*>[\s\S]*?<\/form>/u)?.[0];
  assert.ok(markup, `${page}: editorial form exists`);
  const tag = markup.match(/^<form\b[^>]*>/u)[0];
  assert.equal(attribute(tag, 'onsubmit'), 'prepareEmail(event)');
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
        // A programmatically assigned value does not trigger native tooLong.
        const valid = !this.customError && (!this.required || this.value !== '')
          && (!this.value || !this.matchesPattern || this.matchesPattern.test(this.value));
        if (!valid) { this.invalidCount++; this.dispatch('invalid'); }
        return valid;
      },
    };
    Object.defineProperty(input, 'validity', { get: () => ({ customError: !!input.customError }) });
    elements[name] = input;
  }
  const form = {
    elements,
    dataset: { emailSubject: attribute(tag, 'data-email-subject') },
    reportValidity() {
      // Native validation reports each invalid control, not only the first one.
      return Object.values(elements).map(input => input.reportValidity()).every(Boolean);
    },
  };
  const navigations = [];
  let href = 'about:blank';
  const window = { location: {
    get href() { return href; },
    set href(value) { href = value; navigations.push(value); },
  } };
  const context = createContext({ document: { querySelectorAll: () => [form] }, window });
  runInContext(script, context, { filename: 'assets/form.js' });
  function directSubmit() {
    let prevented = false;
    context.prepareEmail({ currentTarget: form, preventDefault() { prevented = true; } });
    assert.ok(prevented);
  }
  function submit() {
    if (form.reportValidity()) directSubmit();
  }
  return { elements, form, context, window, navigations, directSubmit, submit };
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
      const nativePatternAccepts = !!phone && elements.phone.matchesPattern.test(phone);
      assert.equal(nativePatternAccepts, valid, `${page}: HTML v-pattern ${JSON.stringify(phone)}`);
    }
  });
  test(`${page}: native required blocks an empty name; direct handler also guards an empty phone`, () => {
    const view = makePage(page);
    view.elements.phone.value = '79212345678';
    view.elements.location.value = 'СПб';
    view.submit();
    assert.ok(view.elements.name.invalidCount);
    assert.equal(view.navigations.length, 0);
    view.elements.name.input('Анна');
    view.elements.phone.value = '';
    view.directSubmit();
    assert.ok(view.elements.phone.customError);
    assert.equal(view.navigations.length, 0);
    view.elements.phone.input('79212345678');
    view.submit();
    assert.equal(view.navigations.length, 1);
  });

  test(`${page}: whitespace-only name blocks mailto and correction clears the error`, () => {
    const view = makePage(page);
    const { name, phone, location } = view.elements;
    name.value = ' \t ';
    phone.value = '+7 (921) 234-56-78';
    location.value = 'Санкт-Петербург';
    view.submit();
    assert.match(name.customError, /имя/u);
    assert.equal(view.navigations.length, 0);
    name.input('Анна');
    assert.equal(name.customError, '');
    view.submit();
    assert.equal(view.navigations.length, 1);
  });

  test(`${page}: native invalid phone, blur and corrected input do not leave a sticky error`, () => {
    const view = makePage(page);
    const { name, phone, location } = view.elements;
    name.value = 'Анна';
    location.value = 'СПб';
    phone.value = 'abc 79212345678';
    view.submit(); // Native pattern prevents the submit handler before it runs.
    assert.ok(phone.invalidCount);
    assert.ok(phone.customError);
    assert.equal(view.navigations.length, 0);
    phone.input('79212345678');
    assert.equal(phone.customError, '');
    phone.dispatch('blur');
    assert.equal(phone.customError, '');
    view.submit();
    assert.equal(view.navigations.length, 1);
  });

  test(`${page}: direct handler validates programmatic maxlength and required values`, () => {
    const view = makePage(page);
    const { name, phone, object, location } = view.elements;
    name.value = 'Анна';
    phone.value = '1-2-3-4-5-6-7-8-9-0-1-2-3-4-5-6-7-8-9-0-1';
    location.value = 'СПб';
    view.directSubmit();
    assert.match(phone.customError, /40/u);
    assert.equal(view.navigations.length, 0);
    phone.input('79212345678');
    name.value = 'А'.repeat(101);
    view.directSubmit();
    assert.match(name.customError, /100/u);
    assert.equal(view.navigations.length, 0);
    name.input('Анна');
    object.value = 'Д'.repeat(201);
    view.directSubmit();
    assert.match(object.customError, /200/u);
    assert.equal(view.navigations.length, 0);
    object.input('Дом');
    location.value = 'М'.repeat(201);
    view.directSubmit();
    assert.match(location.customError, /200/u);
    assert.equal(view.navigations.length, 0);
    location.input('СПб');
    view.submit();
    assert.equal(view.navigations.length, 1);
  });

  test(`${page}: mailto URI encodes every field and only opens one draft`, () => {
    const view = makePage(page);
    view.elements.name.value = ' Анна & Борис? ';
    view.elements.phone.value = ' +7 (921) 234-56-78 ';
    view.elements.object.value = ' Дом & газ\nСУГ ';
    view.elements.location.value = ' СПб? A&B ';
    view.submit();
    assert.equal(view.navigations.length, 1);
    const uri = new URL(view.window.location.href);
    assert.equal(uri.protocol, 'mailto:');
    assert.equal(uri.pathname, 'info@remgaz.com');
    assert.equal(uri.searchParams.get('subject'), page === 'gas.html' ? 'Запрос по доставке СУГ' : 'Запрос по объекту');
    assert.equal(uri.searchParams.get('body'),
      'Имя: Анна & Борис?\nТелефон: +7 (921) 234-56-78\nТип объекта и параметры: Дом & газ\nСУГ\nЛокация: СПб? A&B');
    assert.match(view.window.location.href, /%26/u);
    assert.match(view.window.location.href, /%0A/u);
    assert.match(view.window.location.href, /%2B/u);
  });
}

test('gas.html: a whitespace-only required delivery address blocks even direct submission', () => {
  const view = makePage('gas.html');
  view.elements.name.value = 'Анна';
  view.elements.phone.value = '79212345678';
  view.elements.location.value = ' \t ';
  view.directSubmit();
  assert.ok(view.elements.location.customError);
  assert.equal(view.navigations.length, 0);
  view.elements.location.input('СПб');
  assert.equal(view.elements.location.customError, '');
  view.submit();
  assert.equal(view.navigations.length, 1);
});
