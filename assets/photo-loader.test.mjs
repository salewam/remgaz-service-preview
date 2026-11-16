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

test('explicit thumbnail and initial picture sources keep the bundled variants', () => {
  const { photos } = makeLoader(1440);
  const original = 'https://example.test/site/assets.release/portfolio/project-01.webp';
  for (const mode of ['thumb', 'mobile', 'tablet']) {
    assert.equal(photos.source(original, mode), original.replace('.webp', `-${mode}.webp`));
  }
});

test('uploaded WebP photos never request nonexistent generated variants', () => {
  const { photos, window } = makeLoader();
  const filename = `${'a'.repeat(64)}.webp`;
  for (const width of [390, 900, 1440]) {
    window.innerWidth = width;
    for (const original of [`/media/${filename}`, `https://api.example.test/media/${filename}?v=2#photo`]) {
      for (const mode of ['view', 'large', 'thumb', 'mobile', 'tablet']) {
        assert.equal(photos.source(original, mode), original);
      }
    }
  }
});

test('display clears initial picture sources on every dynamic frame change', () => {
  const { photos } = makeLoader(900);
  const events = [];
  const sources = [1, 2].map(index => ({ remove() { events.push(`remove ${index}`); } }));
  const image = {
    parentElement: { localName: 'picture', querySelectorAll: () => sources },
    set src(value) { events.push(`src ${value}`); }
  };
  photos.display(image, 'assets/photo-02-tablet.webp');
  assert.deepEqual(events, ['src assets/photo-02-tablet.webp', 'remove 1', 'remove 2']);
  events.length = 0;
  image.parentElement = { localName: 'div' };
  photos.display(image, 'assets/photo-03-thumb.webp');
  assert.deepEqual(events, ['src assets/photo-03-thumb.webp']);
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


test('delivery photos remain browsable without a descriptive side panel', async () => {
  const html = readFileSync(new URL('../gas.html', import.meta.url), 'utf8');
  const gallery = html.match(/<figure class="hero-photo">([\s\S]*?)<\/figure>/u)?.[1];
  assert.ok(gallery, 'delivery photo gallery exists');
  assert.doesNotMatch(gallery, /<a\b/u, 'the gallery has no descriptive application panel');
  const galleryScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
    .map(([, source]) => source).find(source => source.includes('gasHeroImg'));
  assert.ok(galleryScript);
  const attribute = (tag, name) => tag.match(new RegExp('\\b' + name + '="([^"]*)"', 'u'))?.[1];
  const element = () => {
    const attributes = new Map();
    const listeners = new Map();
    return {
      children: [], textContent: '',
      append(child) { this.children.push(child); },
      getAttribute(name) { return attributes.get(name); },
      setAttribute(name, value) { attributes.set(name, value); },
      removeAttribute(name) { attributes.delete(name); },
      addEventListener(type, listener) { listeners.set(type, listener); },
      click() { listeners.get('click')(); },
    };
  };
  const frame = element();
  const picture = element();
  const caption = element();
  const number = element();
  const menu = element();
  menu.querySelectorAll = () => [];
  const thumbs = [...gallery.matchAll(/<button\b[^>]*>(<img\b[^>]*>)<\/button>/gu)]
    .map(([, imageTag]) => {
      const button = element();
      const image = {
        src: attribute(imageTag, 'src'), complete: true,
        naturalWidth: Number(attribute(imageTag, 'width')),
        naturalHeight: Number(attribute(imageTag, 'height')),
      };
      button.querySelector = () => image;
      return button;
    });
  assert.equal(thumbs.length, 3);
  const photos = new Map(thumbs.map(button => {
    const image = button.querySelector('img');
    const src = image.src.replace('-thumb.webp', '.webp');
    return [src, { ...image, src }];
  }));
  const sources = [...photos.keys()];
  const warmed = [];
  const timers = new Map();
  const document = {
    baseURI: 'https://remgaz.test/gas.html',
    getElementById(id) { return { gasHeroImg: picture, gasPhotoCount: caption, gasPhotoNumber: number }[id] || null; },
    querySelector(selector) { return selector === '.hero-photo-frame' ? frame : menu; },
    querySelectorAll() { return thumbs; },
    createElement: element,
  };
  const loader = {
    source(src) { assert.ok(photos.has(src), 'a full photo address is retained'); return src; },
    load: async src => photos.get(src),
    display(image, src) { image.src = src; },
    prefetch(sources) { warmed.push(...sources); },
  };
  runInContext(galleryScript, createContext({
    document, window: { RemgazPhotos: loader }, URL,
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; }
      observe() { this.callback([{ isIntersecting: true }]); }
    },
    setTimeout(callback) { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
  }));
  await Promise.resolve();
  const previous = frame.children.find(node => node.getAttribute('aria-label') === 'Предыдущее фото доставки');
  const next = frame.children.find(node => node.getAttribute('aria-label') === 'Следующее фото доставки');
  const status = frame.children.find(node => node.getAttribute('role') === 'status');
  assert.ok(previous && next, 'both photo arrows remain');
  const selected = index => {
    assert.equal(picture.src, sources[index]);
    assert.equal(caption.textContent, 'Фото ' + (index + 1) + ' из 3 · Доставка сжиженного газа');
    assert.equal(number.textContent, '0' + (index + 1) + ' / 03');
    thumbs.forEach((button, current) => assert.equal(button.getAttribute('aria-current') === 'true', current === index));
    assert.equal(status.hidden, true);
    assert.equal(timers.size, 0);
  };
  for (const index of [1, 2, 0]) {
    next.click();
    await Promise.resolve();
    selected(index);
  }
  previous.click();
  await Promise.resolve();
  selected(2);
  for (const [index, button] of thumbs.entries()) {
    button.click();
    await Promise.resolve();
    selected(index);
  }
  assert.ok(warmed.length > 0, 'neighbor photos are still preloaded');
});
