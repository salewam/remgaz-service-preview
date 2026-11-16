import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const adminHTML = readFileSync(new URL('../admin/index.html', import.meta.url), 'utf8');
const adminScript = readFileSync(new URL('./admin.js', import.meta.url), 'utf8');
const contentScript = readFileSync(new URL('./site-content.js', import.meta.url), 'utf8');
const example = JSON.parse(readFileSync(new URL('../content/site.json', import.meta.url), 'utf8')).projects.find(project => project.id === 'home');

class Element {
  constructor(tag = 'div') {
    this.tag = tag; this.className = ''; this.children = []; this.dataset = {}; this.attributes = new Map();
    this.listeners = new Map(); this.hidden = false; this.value = ''; this._text = '';
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.classList = { toggle: (name, active) => {
      const classes = new Set(this.className.split(' ').filter(Boolean));
      if (active) classes.add(name); else classes.delete(name);
      this.className = [...classes].join(' ');
    } };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(node => node.textContent).join(''); }
  get childElementCount() { return this.children.length; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  addEventListener(name, listener) { this.listeners.set(name, listener); }
  emit(name) { return this.listeners.get(name)?.({ target: this, preventDefault() {} }); }
  scrollIntoView() {}
  descendants() { return this.children.flatMap(node => [node, ...node.descendants()]); }
  matches(selector) { return selector.startsWith('.') ? this.className.split(' ').includes(selector.slice(1)) : this.tag === selector; }
  querySelectorAll(selector) {
    if (selector.includes(' > ')) {
      const [parent, child] = selector.split(' > ');
      return this.querySelectorAll(parent).flatMap(node => node.children.filter(item => item.matches(child)));
    }
    const [first, ...rest] = selector.split(/\s+/u);
    if (rest.length) return this.querySelectorAll(first).flatMap(node => node.querySelectorAll(rest.join(' ')));
    return this.descendants().filter(node => node.matches(selector));
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

const createTextNode = text => { const node = new Element('#text'); node.textContent = text; return node; };

test('task, work description and primary facts are visible without opening extra fields', () => {
  const main = adminHTML.replace(/<details\b[\s\S]*?<\/details>/gu, '');
  const fields = [...main.matchAll(/<textarea\b[^>]*name="([^"]+)"/gu)].map(([, name]) => name);
  assert.deepEqual(fields, ['task', 'work', 'facts']);
  const allFields = [...adminHTML.matchAll(/<(?:input|textarea)\b[^>]*name="([^"]+)"/gu)].map(([, name]) => name);
  for (const name of ['desc', 'task', 'work', 'facts']) assert.equal(allFields.filter(field => field === name).length, 1);
});

test('editor saves task, multiline work and ordered facts without changing photos or the price', async () => {
  const nodes = new Map([...adminHTML.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/gu)]
    .map(([, tag, id]) => [id, new Element(tag)]));
  const fields = new Map([...adminHTML.matchAll(/<(input|textarea)\b[^>]*name="([^"]+)"[^>]*>/gu)]
    .map(([, tag, name]) => [name, new Element(tag)]));
  const form = nodes.get('project-form');
  form.elements = { namedItem: name => fields.get(name) };
  let data = { revision: 1, gasPriceRub: 50, projects: [structuredClone(example)] };
  let saved;
  const document = {
    currentScript: { src: 'https://example.test/assets/admin.js' },
    getElementById: id => nodes.get(id), createElement: tag => new Element(tag),
  };
  runInNewContext(adminScript, {
    document, URL, AbortSignal, structuredClone,
    location: { origin: 'https://example.test' },
    window: { Telegram: { WebApp: { initData: 'isolated-unit-test' } }, addEventListener() {}, confirm: () => true },
    fetch: async (path, options) => {
      if (options.method === 'PUT') {
        assert.equal(path, '/api/admin/projects/' + example.id);
        saved = JSON.parse(options.body);
        assert.equal(saved.revision, data.revision);
        data = { ...data, revision: data.revision + 1, projects: [structuredClone(saved.project)] };
      }
      return { ok: true, json: async () => structuredClone(data) };
    },
  });
  await new Promise(setImmediate);
  nodes.get('project-list').children[0].emit('click');
  assert.equal(fields.get('task').value, example.task);
  assert.equal(fields.get('work').value, example.work);
  assert.equal(fields.get('facts').value, example.facts.map(fact => fact.label + ' — ' + fact.value).join('\n'));
  fields.get('task').value = 'Обеспечить комплекс теплом.';
  fields.get('work').value = 'Монтаж котельной 68 кВт.\nКотлы Naneo 34 кВт.';
  fields.get('facts').value = 'Мощность котельной — 68 кВт\nГазовые котлы — Naneo 34 кВт';
  await form.emit('submit');
  assert.equal(saved.project.task, fields.get('task').value);
  assert.equal(saved.project.work, fields.get('work').value);
  assert.equal(saved.project.desc, example.desc);
  assert.deepEqual(saved.project.facts, [
    { label: 'Мощность котельной', value: '68 кВт' },
    { label: 'Газовые котлы', value: 'Naneo 34 кВт' },
  ]);
  assert.deepEqual(saved.project.photos, example.photos);
  assert.equal(saved.project.coverPhoto, example.coverPhoto);
  assert.equal(data.gasPriceRub, 50);
  nodes.get('project-list').children[0].emit('click');
  assert.equal(fields.get('work').value, saved.project.work);
  assert.equal(fields.get('facts').value, 'Мощность котельной — 68 кВт\nГазовые котлы — Naneo 34 кВт');
});

test('portfolio hides empty labels and reveals filled sections with unchanged fact order', async () => {
  const list = new Element();
  const document = {
    baseURI: 'https://example.test/portfolio.html', currentScript: { src: 'https://example.test/assets/site-content.js' },
    createElement: tag => new Element(tag), createTextNode,
    querySelector: selector => selector === '.project-list' ? list : null,
    querySelectorAll: () => [],
  };
  const window = { RemgazPhotos: { source: src => src, display(image, src) { image.src = src; } } };
  const project = { ...structuredClone(example), desc: 'Котельная СПА-комплекса.', task: '', work: '  ', facts: [] };
  const render = async () => {
    runInNewContext(contentScript, {
      document, window, URL, AbortController, setTimeout, clearTimeout,
      location: { origin: 'https://example.test' },
      fetch: async () => ({ ok: true, json: async () => ({ revision: 1, gasPriceRub: 50, projects: [structuredClone(project)] }) }),
    });
    await window.RemgazContent.ready;
  };
  await render();
  const article = list.children[0];
  const paragraphs = article.querySelectorAll('.project-copy > p');
  const facts = article.querySelector('.project-facts');
  assert.deepEqual(paragraphs.map(node => node.hidden), [false, true, true]);
  assert.equal(facts.hidden, true);
  project.desc = '';
  project.task = 'Обеспечить комплекс теплом.';
  project.work = 'Монтаж котельной 68 кВт.\nКотлы Naneo 34 кВт.';
  project.facts = [{ label: 'Мощность', value: '68 кВт' }, { label: 'Котлы', value: 'Naneo 34 кВт' }];
  await render();
  assert.equal(list.children[0], article);
  assert.deepEqual(paragraphs.map(node => node.hidden), [true, false, false]);
  assert.equal(paragraphs[1].textContent, 'Задача: ' + project.task);
  assert.equal(paragraphs[2].textContent, 'Решение: ' + project.work);
  assert.equal(facts.hidden, false);
  assert.deepEqual(facts.children.map(row => ({ label: row.querySelector('dt').textContent, value: row.querySelector('dd').textContent })), project.facts);
  project.facts = [];
  await render();
  assert.equal(facts.hidden, true, 'numbers are not extracted from work text automatically');
});

test('homepage case feed renders all published projects, excludes unpublished, and falls back to work when desc is empty', async () => {
  const track = new Element('div');
  track.className = 'case-triad case-carousel-track';
  const document = {
    baseURI: 'https://example.test/', currentScript: { src: 'https://example.test/assets/site-content.js' },
    createElement: tag => new Element(tag), createTextNode,
    querySelector: selector => (selector.includes('case-triad') || selector.includes('case-carousel-track')) ? track : null,
    querySelectorAll: () => [],
  };
  const window = {
    RemgazPhotos: { source: (src, mode) => src, display(image, src) { image.src = src; } },
    RemgazCaseCarousel: { init() {} }
  };
  const publishedProject1 = { ...structuredClone(example), id: 'p1', title: 'Проект 1', published: true, cardDesc: 'Карточка 1' };
  const publishedProject2 = { ...structuredClone(example), id: 'p2', title: 'Проект 2', published: true, cardDesc: '', desc: '', work: 'Выполненные работы 2' };
  const unpublishedProject = { ...structuredClone(example), id: 'p3', title: 'Черновик', published: false };
  
  runInNewContext(contentScript, {
    document, window, URL, AbortController, setTimeout, clearTimeout,
    location: { origin: 'https://example.test' },
    fetch: async () => ({
      ok: true,
      json: async () => ({
        revision: 1,
        gasPriceRub: 50,
        projects: [publishedProject1, unpublishedProject, publishedProject2]
      })
    }),
  });
  await window.RemgazContent.ready;

  assert.equal(track.children.length, 2, 'unpublished project is excluded');
  assert.equal(track.children[0].dataset.projectId, 'p1');
  assert.equal(track.children[1].dataset.projectId, 'p2');
  assert.equal(track.children[0].querySelector('.case-body > p').textContent, 'Карточка 1');
  assert.equal(track.children[1].querySelector('.case-body > p').textContent, 'Выполненные работы 2', 'fallback to work when cardDesc and desc are empty');
  assert.equal(track.children[0].querySelector('.case-body h3 a').getAttribute('href') || track.children[0].querySelector('.case-body h3 a').href, 'portfolio.html#p1');
});
