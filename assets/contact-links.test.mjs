import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  test(`${page}: footer phone and email are native contact links`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/u)?.[1];
    assert.ok(footer, `${page}: footer exists`);
    const links = [...footer.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)]
      .map(([, href, content]) => ({ href, text: content.replace(/<[^>]*>/gu, '').trim() }));

    const phone = links.find(link => link.text === '8 (812) 385-53-53');
    const email = links.find(link => link.text === 'info@remgaz.com');
    assert.ok(phone, `${page}: phone number is a link, not plain text`);
    assert.ok(email, `${page}: email address is a link, not plain text`);
    assert.equal(phone.href, 'tel:+78123855353');
    assert.equal(email.href, 'mailto:info@remgaz.com');
  });
}


const phoneScript = readFileSync(new URL('./phone.js', import.meta.url), 'utf8');

function phonePage({ clipboardWorks = true, dialogSupported = true } = {}) {
  let document;
  class Node {
    constructor(tag) {
      this.tag = tag; this.children = []; this.attributes = new Map(); this.listeners = new Map();
      this.style = {}; this.textContent = ''; this.className = ''; this.isConnected = true;
      if (tag === 'dialog' && dialogSupported) this.showModal = () => { this.open = true; };
    }
    append(...nodes) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
    setAttribute(name, value) { this.attributes.set(name, value); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    addEventListener(name, callback) { this.listeners.set(name, callback); }
    closest(selector) {
      if (this.tag === 'a' && this.getAttribute('href')?.startsWith('tel:')) return this;
      return this.parent?.closest(selector) || null;
    }
    focus() { document.activeElement = this; }
    select() { this.selected = true; }
    close() { this.open = false; this.listeners.get('close')?.(); }
    descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  }
  const listeners = new Map();
  const copied = [];
  document = {
    head: new Node('head'), body: new Node('body'),
    createElement: tag => new Node(tag),
    addEventListener: (name, callback) => listeners.set(name, callback),
  };
  document.body.style.overflow = 'auto';
  runInNewContext(phoneScript, {
    document,
    navigator: { clipboard: { async writeText(value) {
      if (!clipboardWorks) throw new Error('Clipboard denied');
      copied.push(value);
    } } },
  });
  return {
    document, copied,
    get dialog() { return document.body.children.find(node => node.tag === 'dialog'); },
    find(predicate) { return document.body.descendants().find(predicate); },
    link(href = 'tel:+78123855353') {
      const link = new Node('a'); link.setAttribute('href', href); document.body.append(link); return link;
    },
    async click(target, options = {}) {
      const event = { target, button: 0, defaultPrevented: false, preventDefault() { this.defaultPrevented = true; }, ...options };
      const result = target.listeners.get('click')?.(event);
      listeners.get('click')?.(event);
      await result;
      return event;
    },
  };
}

for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  test(page + ': every phone link shows the number before launching a call app', async () => {
    const html = readFileSync(new URL('../' + page, import.meta.url), 'utf8');
    assert.equal([...html.matchAll(/<script\b[^>]*src="assets\/phone\.js"[^>]*><\/script>/gu)].length, 1);
    const phones = [...html.matchAll(/<a\b[^>]*href="(tel:[^"]+)"/gu)].map(([, href]) => href);
    assert.ok(phones.length > 0);
    const ui = phonePage();
    for (const href of phones) {
      const trigger = ui.link(href);
      const event = await ui.click(trigger);
      assert.equal(event.defaultPrevented, true, 'the first click does not open another app');
      assert.equal(ui.dialog.open, true);
      const number = ui.find(node => node.tag === 'input');
      const call = ui.find(node => node.textContent === 'Набрать номер');
      assert.equal(number.value, '+7 (812) 385-53-53');
      assert.equal(number.readOnly, true);
      assert.equal(call.getAttribute('href'), href);
      assert.equal((await ui.click(call)).defaultPrevented, false, 'explicit dialing uses the native telephone handler');
      await ui.click(ui.find(node => node.getAttribute('aria-label') === 'Закрыть номер телефона'));
      assert.equal(ui.dialog.open, false);
      assert.equal(ui.document.activeElement, trigger);
      assert.equal(ui.document.body.style.overflow, 'auto');
    }
    assert.equal(ui.document.head.children.length, 1, 'one reusable dialog stylesheet');
  });
}

test('copying uses the current phone number and clears the previous confirmation on reopening', async () => {
  const ui = phonePage();
  await ui.click(ui.link());
  const copy = ui.find(node => node.textContent === 'Скопировать');
  const status = ui.find(node => node.getAttribute('role') === 'status');
  await ui.click(copy);
  assert.deepEqual(ui.copied, ['+78123855353']);
  assert.equal(status.textContent, 'Номер скопирован.');
  await ui.click(ui.dialog);
  assert.equal(ui.dialog.open, false);
  await ui.click(ui.link('tel:+74951234567'));
  assert.equal(status.textContent, '');
  assert.equal(ui.find(node => node.tag === 'input').value, '+7 (495) 123-45-67');
  await ui.click(copy);
  assert.deepEqual(ui.copied, ['+78123855353', '+74951234567']);
});

test('blocked clipboard leaves the full phone number selected for manual copying', async () => {
  const ui = phonePage({ clipboardWorks: false });
  await ui.click(ui.link());
  await ui.click(ui.find(node => node.textContent === 'Скопировать'));
  const number = ui.find(node => node.tag === 'input');
  assert.equal(number.selected, true);
  assert.equal(ui.document.activeElement, number);
  assert.match(ui.find(node => node.getAttribute('role') === 'status').textContent, /Скопируйте выделенный номер/u);
  assert.deepEqual(ui.copied, []);
});

test('mail links, modified clicks and browsers without dialogs keep their native behavior', async () => {
  const ui = phonePage();
  assert.equal((await ui.click(ui.link('mailto:info@remgaz.com'))).defaultPrevented, false);
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    assert.equal((await ui.click(ui.link(), options)).defaultPrevented, false);
  }
  assert.equal(ui.dialog, undefined);
  const basic = phonePage({ dialogSupported: false });
  assert.equal((await basic.click(basic.link())).defaultPrevented, false);
  assert.equal(basic.dialog, undefined);
});
