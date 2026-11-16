import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const servicesScript = readFileSync(new URL('./services.js', import.meta.url), 'utf8');
const contentScript = readFileSync(new URL('./site-content.js', import.meta.url), 'utf8');
const attribute = (tag, name) => tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'u'))?.[1];

function servicePage() {
  const document = { activeElement: null };
  const panels = new Map([...html.matchAll(/<div\b[^>]*role="tabpanel"[^>]*>/gu)]
    .map(([tag]) => [attribute(tag, 'id'), { hidden: /\shidden(?:\s|>)/u.test(tag) }]));
  const tabs = [...html.matchAll(/<article class="(service-card[^"]*)">([\s\S]*?)<\/article>/gu)]
    .map(([, className, content]) => {
      const [button, label] = content.match(/<button\b[^>]*>([^<]+)<\/button>/u) || [];
      assert.ok(button, 'each service card has a tab');
      const attributes = new Map([...button.matchAll(/([\w-]+)="([^"]*)"/gu)].map(([, name, value]) => [name, value]));
      const classes = new Set(className.split(' '));
      const listeners = new Map();
      const card = { classList: { toggle(name, active) { if (active) classes.add(name); else classes.delete(name); } } };
      return {
        id: attributes.get('id'), label, classes,
        tabIndex: Number(attributes.get('tabindex')),
        getAttribute(name) { return attributes.get(name); },
        setAttribute(name, value) { attributes.set(name, value); },
        closest() { return card; },
        addEventListener(type, listener) { listeners.set(type, listener); },
        focus() { document.activeElement = this; },
        click() { listeners.get('click')(); },
        key(key) {
          let prevented = false;
          listeners.get('keydown')({ key, preventDefault() { prevented = true; } });
          assert.ok(prevented, `${key}: native scrolling is prevented`);
        },
      };
    });
  document.getElementById = id => id === 'services' ? { querySelectorAll: () => tabs } : panels.get(id);
  return { tabs, panels, document, start() { runInNewContext(servicesScript, { document }); } };
}

function assertActive(page, selectedId) {
  assert.equal(page.tabs.length, 4);
  assert.equal(page.panels.size, 4);
  for (const tab of page.tabs) {
    const active = tab.id === selectedId;
    assert.equal(tab.getAttribute('aria-selected'), String(active), tab.id);
    assert.equal(tab.tabIndex, active ? 0 : -1, tab.id);
    assert.equal(tab.classes.has('service-card-featured'), active, tab.id);
    assert.equal(page.panels.get(tab.getAttribute('aria-controls')).hidden, !active, tab.id);
  }
}

test('gas delivery is highlighted with its panel visible before and after initialization', () => {
  const page = servicePage();
  assert.equal(page.tabs[3].label, 'Доставка сжиженного газа');
  assertActive(page, 'service-tab-04');
  page.start();
  assertActive(page, 'service-tab-04');
});

test('clicks and keyboard navigation keep exactly one highlighted service and visible panel', () => {
  const page = servicePage();
  page.start();
  for (const tab of page.tabs) {
    tab.click();
    assertActive(page, tab.id);
  }
  for (const [from, key, to] of [[3, 'ArrowRight', 0], [0, 'ArrowLeft', 3], [3, 'Home', 0], [0, 'End', 3]]) {
    page.tabs[from].key(key);
    assertActive(page, page.tabs[to].id);
    assert.equal(page.document.activeElement, page.tabs[to]);
  }
});

test('delivery price badge keeps its wording when the content API changes the price', async () => {
  const badge = html.match(/<a\b[^>]*class="hero-gas-price"[^>]*>([\s\S]*?)<\/a>/u);
  assert.ok(badge, 'delivery price badge exists');
  assert.equal(attribute(badge[0], 'href'), 'gas.html#price');
  const label = badge[1].match(/<span class="hero-gas-price-label">([^<]+)<\/span>/u)?.[1];
  const price = badge[1].match(/<strong\b[^>]*\sdata-gas-price(?:="[^"]*")?[^>]*>([^<]+)<\/strong>/u);
  assert.ok(price, 'price is connected to live content');
  const node = { dataset: { gasPrice: attribute(price[0], 'data-gas-price') || '' }, textContent: price[1] };
  const window = { RemgazPhotos: {} };
  const document = {
    currentScript: { src: 'https://remgaz.test/assets/site-content.js' },
    baseURI: 'https://remgaz.test/',
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-gas-price]' ? [node] : []; },
  };
  runInNewContext(contentScript, {
    document, window, URL, AbortController, setTimeout, clearTimeout,
    location: { origin: 'https://remgaz.test' },
    fetch: async () => ({ ok: true, json: async () => ({ revision: 1, gasPriceRub: 63.5, projects: [] }) }),
  });
  await window.RemgazContent.ready;
  assert.equal(window.RemgazContent.state, 'live');
  assert.equal(`${label} ${node.textContent}`, 'Доставка газа от 63,5 ₽/л');
});
