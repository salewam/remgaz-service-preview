import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const script = readFileSync(new URL('./photo-loader.js', import.meta.url), 'utf8');

function makeLoader(width = 390) {
  const images = [];
  class Image {
    constructor() { images.push(this); }
    decode() {
      return new Promise((resolve, reject) => {
        this.finishDecode = resolve;
        this.failDecode = reject;
      });
    }
    finish() { this.onload(); this.finishDecode(); }
  }
  const window = { innerWidth: width };
  const context = createContext({ window, document: { baseURI: 'https://example.test/site/' }, Image, URL });
  runInContext(script, context, { filename: 'assets/photo-loader.js' });
  return { photos: window.RemgazPhotos, window, images };
}

test('responsive sources respect viewport boundaries and preserve query/hash', () => {
  const { photos, window } = makeLoader();
  const original = 'assets/portfolio/project-01.webp?v=2#photo';
  for (const [width, view, large] of [
    [320, 'mobile', 'mobile'], [600, 'mobile', 'mobile'],
    [601, 'tablet', 'tablet'], [1100, 'tablet', 'tablet'],
    [1101, 'view', 'lightbox'], [1440, 'view', 'lightbox'],
  ]) {
    window.innerWidth = width;
    assert.equal(photos.source(original), `assets/portfolio/project-01-${view}.webp?v=2#photo`);
    assert.equal(photos.source(original, 'large'), `assets/portfolio/project-01-${large}.webp?v=2#photo`);
  }
});

test('relative and absolute requests share one in-flight load and decoded image', async () => {
  const { photos, images } = makeLoader();
  const first = photos.load('assets/photo.webp');
  const second = photos.load('https://example.test/site/assets/photo.webp');
  assert.equal(first, second);
  assert.equal(images.length, 1);
  images[0].finish();
  const decoded = await first;
  assert.equal(await second, decoded);
  assert.equal(await photos.load('assets/photo.webp'), decoded);
  assert.equal(images.length, 1);
});

test('load resolves only after decoding, not merely after network completion', async () => {
  const { photos, images } = makeLoader();
  const pending = photos.load('assets/photo.webp');
  let resolved = false;
  pending.then(() => { resolved = true; });
  images[0].onload();
  await Promise.resolve();
  assert.equal(resolved, false);
  images[0].finishDecode();
  assert.equal(await pending, images[0]);
});

test('a selected frame raises pending priority and later prefetch cannot lower it', async () => {
  const { photos, images } = makeLoader();
  const pending = photos.load('assets/photo.webp', 'low');
  assert.equal(images[0].fetchPriority, 'low');
  photos.load('assets/photo.webp');
  assert.equal(images[0].fetchPriority, 'auto');
  photos.prefetch(['assets/photo.webp']);
  assert.equal(images[0].fetchPriority, 'auto');
  photos.load('assets/photo.webp', 'high');
  photos.load('assets/photo.webp');
  photos.prefetch(['assets/photo.webp']);
  assert.equal(images[0].fetchPriority, 'high');
  assert.equal(images.length, 1);
  images[0].finish();
  await pending;
});

for (const failure of ['network', 'decode']) {
  test(`${failure} failure is not cached and the next explicit request can succeed`, async () => {
    const { photos, images } = makeLoader();
    const pending = photos.load('assets/photo.webp');
    const rejected = assert.rejects(pending);
    if (failure === 'network') images[0].onerror();
    else { images[0].onload(); images[0].failDecode(new Error('Cannot decode')); }
    await rejected;
    const retry = photos.load('assets/photo.webp');
    assert.equal(images.length, 2);
    images[1].finish();
    assert.equal(await retry, images[1]);
  });
}

test('prefetch deduplicates sources and consumes failures without blocking later selection', async () => {
  const { photos, images } = makeLoader();
  photos.prefetch(['assets/photo.webp', 'assets/photo.webp']);
  assert.equal(images.length, 1);
  assert.equal(images[0].fetchPriority, 'low');
  images[0].onerror();
  await new Promise(resolve => setImmediate(resolve));
  const selected = photos.load('assets/photo.webp', 'high');
  assert.equal(images.length, 2);
  images[1].finish();
  assert.equal(await selected, images[1]);
});

test('decoded cache stays bounded rather than retaining an entire catalogue', async () => {
  const { photos, images } = makeLoader();
  for (let index = 0; index < 21; index++) {
    const pending = photos.load(`assets/photo-${index}.webp`);
    images.at(-1).finish();
    await pending;
  }
  const newest = images.at(-1);
  assert.equal(await photos.load('assets/photo-20.webp'), newest);
  const reload = photos.load('assets/photo-0.webp');
  assert.equal(images.length, 22);
  images.at(-1).finish();
  assert.notEqual(await reload, images[0]);
});
