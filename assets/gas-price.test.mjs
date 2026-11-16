import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

const html = readFileSync(new URL('../gas.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('./site-content.js', import.meta.url), 'utf8');

test('delivery price starts with от before and after the API updates its value', async () => {
  const heading = html.match(/<h2\b[^>]*id="price-title"[^>]*>([\s\S]*?)<\/h2>/u);
  assert.ok(heading, 'delivery price heading exists');
  const unit = { textContent: heading[1].match(/<span>([^<]+)<\/span>/u)?.[1] };
  assert.equal(unit.textContent, '₽/л');
  const node = {
    dataset: { gasPrice: heading[0].match(/data-gas-price="([^"]*)"/u)?.[1] },
    children: [{ textContent: heading[1].split('<')[0] }, unit],
    get textContent() { return this.children.map(child => child.textContent).join(''); },
    querySelector(selector) { return selector === 'span' ? unit : null; },
    replaceChildren(...children) { this.children = children; },
  };
  assert.match(node.textContent, /^от \d+(?:[.,]\d+)? ₽\/л$/u);
  const window = { RemgazPhotos: {} };
  const document = {
    currentScript: { src: 'https://remgaz.test/assets/site-content.js' },
    baseURI: 'https://remgaz.test/gas.html',
    querySelector() { return null; },
    querySelectorAll(selector) { return selector === '[data-gas-price]' ? [node] : []; },
    createTextNode(textContent) { return { textContent }; },
  };
  runInNewContext(script, {
    document, window, URL, AbortController, setTimeout, clearTimeout,
    location: { origin: 'https://remgaz.test' },
    fetch: async () => ({ ok: true, json: async () => ({ revision: 1, gasPriceRub: 63.5, projects: [] }) }),
  });
  await window.RemgazContent.ready;
  assert.equal(window.RemgazContent.state, 'live');
  assert.equal(node.textContent, 'от 63,5 ₽/л');
  assert.equal(node.children[1], unit, 'the separate unit keeps its smaller styling');
});
