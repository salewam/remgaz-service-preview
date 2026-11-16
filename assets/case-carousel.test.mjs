import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const carouselScript = readFileSync(new URL('./case-carousel.js', import.meta.url), 'utf8');

class Element {
  constructor(tag = 'div', className = '') {
    this.tag = tag;
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this.scrollLeft = 0;
    this.scrollWidth = 1000;
    this.clientWidth = 300;
    this.style = {};
    this.lastScrollOptions = null;
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k); }
  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(fn);
  }
  emit(name, event = {}) {
    for (const fn of (this.listeners.get(name) || [])) fn({ target: this, ...event });
  }
  querySelector(sel) {
    if (sel.includes('.case-carousel-prev')) return this.children.find(c => c.className.includes('prev'));
    if (sel.includes('.case-carousel-next')) return this.children.find(c => c.className.includes('next'));
    if (sel.includes('.case-carousel-toggle')) return this.children.find(c => c.className.includes('toggle'));
    if (sel.includes('.case-carousel-track') || sel.includes('.case-triad')) return this.children.find(c => c.className.includes('track'));
    if (sel.includes('.case-carousel-status')) return this.children.find(c => c.className.includes('status'));
    if (sel.includes('.case-carousel-toggle-text')) return this.children.find(c => c.className.includes('toggle-text'));
    if (sel.includes('.case-box')) return this.children.find(c => c.className.includes('case-box'));
    return null;
  }
  querySelectorAll(sel) {
    return this.children.filter(c => c.className.includes(sel.replace('.', '')));
  }
  closest() { return this; }
  getBoundingClientRect() { return { width: 300 }; }
  scrollTo(opts) { this.lastScrollOptions = opts; this.scrollLeft = opts.left; }
  scrollBy(opts) { this.lastScrollOptions = opts; this.scrollLeft += opts.left; }
}

function makeClock() {
  let currentTime = 0;
  let nextId = 1;
  const timers = new Map();

  return {
    get now() { return currentTime; },
    setTimeout(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, triggerAt: currentTime + delay, isInterval: false });
      return id;
    },
    setInterval(fn, delay) {
      const id = nextId++;
      timers.set(id, { fn, triggerAt: currentTime + delay, delay, isInterval: true });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    clearInterval(id) { timers.delete(id); },
    hasInterval() {
      return Array.from(timers.values()).some(t => t.isInterval);
    },
    advance(ms) {
      const targetTime = currentTime + ms;
      while (true) {
        let earliestId = null;
        let earliestTrigger = Infinity;
        for (const [id, t] of timers.entries()) {
          if (t.triggerAt <= targetTime && t.triggerAt < earliestTrigger) {
            earliestTrigger = t.triggerAt;
            earliestId = id;
          }
        }
        if (earliestId === null) break;
        currentTime = earliestTrigger;
        const entry = timers.get(earliestId);
        if (!entry) continue;
        if (entry.isInterval) {
          entry.triggerAt = currentTime + entry.delay;
        } else {
          timers.delete(earliestId);
        }
        entry.fn();
      }
      currentTime = targetTime;
    }
  };
}

test('case carousel: controlled clock tests for pause, programmatic vs user scroll, reduced-motion and resize', () => {
  const container = new Element('section', 'case-carousel-section');
  const track = new Element('div', 'case-carousel-track');
  const card1 = new Element('article', 'case-box');
  const card2 = new Element('article', 'case-box');
  const card3 = new Element('article', 'case-box');
  track.append(card1, card2, card3);

  const prevBtn = new Element('button', 'case-carousel-btn case-carousel-prev');
  const nextBtn = new Element('button', 'case-carousel-btn case-carousel-next');
  const toggleBtn = new Element('button', 'case-carousel-btn case-carousel-toggle');
  toggleBtn.setAttribute('aria-pressed', 'false');
  const toggleText = new Element('span', 'case-carousel-toggle-text');
  toggleText.textContent = 'Пауза';
  toggleBtn.append(toggleText);
  const status = new Element('span', 'case-carousel-status');

  container.append(prevBtn, toggleBtn, nextBtn, status, track);

  const mediaListeners = [];
  const mediaQuery = {
    matches: false,
    addEventListener: (type, fn) => mediaListeners.push(fn),
  };

  const windowListeners = new Map();
  const window = {
    matchMedia: () => mediaQuery,
    addEventListener: (type, fn) => {
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    RemgazCaseCarousel: null,
  };
  const document = {
    visibilityState: 'visible',
    readyState: 'complete',
    querySelectorAll: () => [container],
    addEventListener: () => {},
  };

  track.scrollWidth = 300;
  track.clientWidth = 300;

  const clock = makeClock();

  const context = createContext({
    window,
    document,
    getComputedStyle: () => ({ gap: '16px' }),
    parseFloat,
    clearInterval: (id) => clock.clearInterval(id),
    setInterval: (fn, ms) => clock.setInterval(fn, ms),
    clearTimeout: (id) => clock.clearTimeout(id),
    setTimeout: (fn, ms) => clock.setTimeout(fn, ms),
    Math,
  });

  runInContext(carouselScript, context);

  assert.ok(window.RemgazCaseCarousel, 'RemgazCaseCarousel exported');
  const instance = window.RemgazCaseCarousel.init(container);
  assert.ok(instance, 'carousel instance initialized');
  assert.equal(clock.hasInterval(), false, 'no timer when track does not overflow');

  track.scrollWidth = 1000;
  const card4 = new Element('article', 'case-box');
  track.append(card4);

  for (const fn of (windowListeners.get('resize') || [])) fn();
  assert.equal(clock.hasInterval(), true, 'resize 0 -> overflow starts auto-play interval');

  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  instance.pause();
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'true');
  assert.equal(clock.hasInterval(), false, 'pause clears interval');

  instance.play();
  assert.equal(toggleBtn.getAttribute('aria-pressed'), 'false');
  assert.equal(clock.hasInterval(), true, 'play restores interval');

  instance.next();
  assert.equal(track.lastScrollOptions?.behavior, 'smooth', 'default behavior is smooth');

  track.emit('scroll');
  assert.equal(clock.hasInterval(), true, 'programmatic scroll does not cancel interval');

  clock.advance(650);

  track.emit('touchstart');
  track.emit('scroll');
  assert.equal(clock.hasInterval(), false, 'real user touch/scroll cancels interval');

  clock.advance(2900);
  assert.equal(clock.hasInterval(), false, 'interval still suspended before 3s user delay expires');

  clock.advance(200);
  assert.equal(clock.hasInterval(), true, 'interval restored after 3s interaction delay expires');

  const beforeAutoScroll = track.scrollLeft;
  clock.advance(5000);
  assert.ok(track.scrollLeft > beforeAutoScroll, 'auto-scroll advanced by 1 step after 5s');

  mediaQuery.matches = true;
  for (const listener of mediaListeners) listener();
  assert.equal(clock.hasInterval(), false, 'reduced-motion: true clears interval');

  instance.next();
  assert.equal(track.lastScrollOptions?.behavior, 'auto', 'reduced-motion uses behavior: auto');

  mediaQuery.matches = false;
  for (const listener of mediaListeners) listener();
  assert.equal(clock.hasInterval(), true, 'reduced-motion: false restores interval');
});
