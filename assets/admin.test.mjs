import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createContext, runInContext } from 'node:vm';

const script = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
const markup = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));

function element(tag = 'div') {
  const listeners = new Map();
  return {
    tagName: tag.toUpperCase(), children: [], attributes: {}, hidden: false, disabled: false,
    textContent: '', value: '', checked: false, dataset: {},
    classList: { toggle() {} },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
    get childElementCount() { return this.children.length; },
    setAttribute(name, value) { this.attributes[name] = value; },
    querySelectorAll() { return []; },
    scrollIntoView() {},
    addEventListener(type, callback) { listeners.set(type, callback); },
    async fire(type, extra = {}) {
      await listeners.get(type)?.({ preventDefault() {}, target: this, currentTarget: this, ...extra });
      await settle();
    },
  };
}

async function app({ initData = 'signed-telegram-data', leadsError = false } = {}) {
  const nodes = new Map();
  for (const match of markup.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
    const node = element();
    node.hidden = /\shidden(?:\s|>)/.test(match[0]);
    nodes.set(match[1], node);
  }
  const fields = new Map();
  nodes.get('project-form').elements = { namedItem(name) {
    if (!fields.has(name)) fields.set(name, element('input'));
    return fields.get(name);
  } };
  const document = {
    revision: 15, gasPriceRub: 50,
    projects: [{ id: 'saved-project', categoryKey: null, title: 'Объект', loc: 'СПб', desc: 'Описание',
      task: 'Задача', work: 'Работы', navTitle: 'Название', cardDesc: 'Карточка', categorySummary: 'Подпись',
      tags: ['Газ'], facts: [{ label: 'Объём', value: '20 м³' }], photos: [], coverPhoto: '', published: false }],
  };
  const leads = ['queued', 'sent', 'rejected', 'uncertain'].map((delivery, index) => ({
    id: index + 1, createdAt: '2026-11-16T12:00:00.000Z', name: '<Иван & Анна>',
    phone: '+7 (921) 234-56-78', object: 'Котельная', location: 'СПб', delivery,
  }));
  const calls = [];
  let rejectLeads = leadsError;
  const context = createContext({
    document: {
      currentScript: { src: 'https://remgaz.example/assets/admin.js' },
      getElementById(id) { assert.ok(nodes.has(id), `Missing admin element: ${id}`); return nodes.get(id); },
      createElement: element,
    },
    location: { origin: 'https://remgaz.example' }, URL, AbortSignal, crypto: webcrypto, structuredClone,
    window: { Telegram: { WebApp: { initData } }, addEventListener() {}, confirm: () => true },
    fetch: async (path, options) => {
      calls.push({ path, options });
      if (path === '/api/admin/leads') {
        return { ok: !rejectLeads, status: rejectLeads ? 401 : 200,
          json: async () => rejectLeads ? { error: 'Expired' } : { leads } };
      }
      if (options.method === 'PUT') {
        const body = JSON.parse(options.body);
        if (path === '/api/admin/price') document.gasPriceRub = body.gasPriceRub;
        else document.projects[0] = body.project;
        document.revision++;
      }
      return { ok: true, status: 200, json: async () => structuredClone(document) };
    },
  });
  runInContext(script, context, { filename: 'assets/admin.js' });
  await settle();
  return { nodes, fields, calls, document, setLeadsError(value) { rejectLeads = value; } };
}

test('MiniApp never fetches private content or leads outside Telegram', async () => {
  const view = await app({ initData: '' });
  assert.equal(view.calls.length, 0);
  assert.equal(view.nodes.get('workspace').hidden, true);
  assert.match(view.nodes.get('access-title').textContent, /через бота/);
});

test('MiniApp displays saved leads, safe text, callable phones and honest delivery states', async () => {
  const view = await app();
  assert.equal(view.nodes.get('workspace').hidden, false);
  await view.nodes.get('leads-tab').fire('click');
  assert.equal(view.nodes.get('leads-section').hidden, false);
  assert.equal(view.nodes.get('portfolio-section').hidden, true);
  const cards = view.nodes.get('lead-list').children;
  assert.equal(cards.length, 4);
  assert.equal(cards[0].children[0].textContent, '<Иван & Анна>');
  assert.equal(cards[0].children[2].href, 'tel:+79212345678');
  assert.match(cards[0].children.at(-1).textContent, /ожидает отправки/);
  assert.match(cards[1].children.at(-1).textContent, /отправлено в Telegram/);
  assert.match(cards[2].children.at(-1).textContent, /отклонил/);
  assert.match(cards[3].children.at(-1).textContent, /не подтверждена/);
  assert.ok(view.calls.every(call => call.options.headers.Authorization === 'tma signed-telegram-data'));
});

test('Switching to leads preserves the portfolio draft, fields and price editing', async () => {
  const view = await app();
  await view.nodes.get('project-list').children[0].fire('click');
  view.fields.get('title').value = 'Изменённый объект';
  view.fields.get('work').value = 'Новые работы';
  await view.nodes.get('project-form').fire('input', { target: { type: 'text' } });
  await view.nodes.get('leads-tab').fire('click');
  await view.nodes.get('portfolio-tab').fire('click');
  assert.equal(view.fields.get('title').value, 'Изменённый объект');
  assert.equal(view.nodes.get('dirty-label').hidden, false);
  await view.nodes.get('project-form').fire('submit');
  const projectCall = view.calls.find(call => call.path === '/api/admin/projects/saved-project');
  const saved = JSON.parse(projectCall.options.body);
  assert.equal(saved.revision, 15);
  assert.equal(saved.project.title, 'Изменённый объект');
  assert.equal(saved.project.work, 'Новые работы');
  assert.equal(saved.project.task, 'Задача');
  assert.equal(saved.project.cardDesc, 'Карточка');
  assert.deepEqual(saved.project.facts, [{ label: 'Объём', value: '20 м³' }]);
  assert.deepEqual(saved.project.photos, []);
  await view.nodes.get('price-tab').fire('click');
  view.nodes.get('gas-price').value = '51,25';
  await view.nodes.get('price-form').fire('submit');
  assert.equal(view.document.gasPriceRub, 51.25);
  assert.equal(view.nodes.get('lead-list').children.length, 4);
});

test('Lead authorization errors do not hide the editor and can be refreshed', async () => {
  const view = await app({ leadsError: true });
  assert.equal(view.nodes.get('workspace').hidden, false);
  assert.match(view.nodes.get('leads-status').textContent, /Срок доступа истёк/);
  view.setLeadsError(false);
  await view.nodes.get('reload-leads').fire('click');
  assert.equal(view.nodes.get('lead-list').children.length, 4);
  assert.equal(view.nodes.get('reload-leads').disabled, false);
});
