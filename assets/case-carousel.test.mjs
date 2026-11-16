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
    if (sel.includes('.case-carousel-track') || sel.includes('.case-triad')) return this.children.find(c => c.className.includes('track'));
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
    clearTimeout(id) {
      timers.delete(id);
    },
    clearInterval(id) {
      timers.delete(id);
    },
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

test('case carousel: automatic 7s step, no button dependency, hover/focus non-blocking, user interaction delay, reduced-motion, wrap', () => {
  const container = new Element('section', 'case-carousel-section');
  const track = new Element('div', 'case-carousel-track');
  const card1 = new Element('article', 'case-box');
  const card2 = new Element('article', 'case-box');
  const card3 = new Element('article', 'case-box');
  track.append(card1, card2, card3);
  container.append(track);

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
  let visibilityState = 'visible';
  const docListeners = new Map();
  const document = {
    get visibilityState() { return visibilityState; },
    readyState: 'complete',
    querySelectorAll: () => [container],
    addEventListener: (type, fn) => {
      if (!docListeners.has(type)) docListeners.set(type, []);
      docListeners.get(type).push(fn);
    },
  };

  track.scrollWidth = 300;
  track.clientWidth = 300;

  const clock = makeClock();

  let observerCallback = null;
  class MockIntersectionObserver {
    constructor(cb) {
      observerCallback = cb;
    }
    observe() {}
    disconnect() {}
  }

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
    IntersectionObserver: MockIntersectionObserver,
  });

  runInContext(carouselScript, context);

  assert.ok(window.RemgazCaseCarousel, 'RemgazCaseCarousel exported');
  const instance = window.RemgazCaseCarousel.init(container);
  assert.ok(instance, 'carousel instance initialized');
  assert.equal(typeof instance.update, 'function', 'has update method');
  assert.equal(typeof instance.destroy, 'function', 'has destroy method');
  assert.equal(instance.play, undefined, 'legacy play removed');
  assert.equal(instance.pause, undefined, 'legacy pause removed');
  assert.equal(instance.next, undefined, 'legacy next removed');
  assert.equal(instance.prev, undefined, 'legacy prev removed');
  assert.equal(clock.hasInterval(), false, 'no timer when track does not overflow');

  // Add more cards so track overflows
  track.scrollWidth = 1000;
  const card4 = new Element('article', 'case-box');
  track.append(card4);

  // Resize notification triggers timer
  for (const fn of (windowListeners.get('resize') || [])) fn();
  assert.equal(clock.hasInterval(), true, 'resize 0 -> overflow starts auto-play interval');

  // Verify hover (pointerenter/pointerleave) does NOT stop timer
  container.emit('pointerenter');
  assert.equal(clock.hasInterval(), true, 'pointerenter does not stop auto-play interval');
  container.emit('pointerleave');
  assert.equal(clock.hasInterval(), true, 'pointerleave keeps auto-play interval running');

  // Verify focusin/focusout does NOT stop timer
  container.emit('focusin');
  assert.equal(clock.hasInterval(), true, 'focusin does not stop auto-play interval');
  container.emit('focusout');
  assert.equal(clock.hasInterval(), true, 'focusout keeps auto-play interval running');

  // Verify 7s step advance
  const pos0 = track.scrollLeft;
  clock.advance(6900);
  assert.equal(track.scrollLeft, pos0, 'no step before 7000ms');
  clock.advance(200);
  assert.ok(track.scrollLeft > pos0, 'stepped forward after 7000ms');
  assert.equal(track.lastScrollOptions?.behavior, 'smooth', 'default scroll behavior is smooth');

  // Programmatic scroll does not cancel interval
  track.emit('scroll');
  assert.equal(clock.hasInterval(), true, 'programmatic scroll does not cancel interval');

  clock.advance(650);

  // Real user interaction (touch/pointer/scroll) pauses interval for 3s
  track.emit('touchstart');
  track.emit('scroll');
  assert.equal(clock.hasInterval(), false, 'real user touch/scroll cancels interval');

  clock.advance(2900);
  assert.equal(clock.hasInterval(), false, 'interval still suspended before 3s interaction delay expires');

  clock.advance(200);
  assert.equal(clock.hasInterval(), true, 'interval restored after 3s interaction delay expires');

  // Step advances again after restored 7s
  const posAfterTouch = track.scrollLeft;
  clock.advance(7000);
  assert.ok(track.scrollLeft > posAfterTouch, 'auto-step advances after restored 7s');

  // End of track wraps to 0
  track.scrollLeft = track.scrollWidth - track.clientWidth - 5;
  clock.advance(7000);
  assert.equal(track.scrollLeft, 0, 'wraps around to 0 at end of track');

  // Document visibility change pauses and resumes
  visibilityState = 'hidden';
  for (const fn of (docListeners.get('visibilitychange') || [])) fn();
  assert.equal(clock.hasInterval(), false, 'hidden document visibility stops interval');

  visibilityState = 'visible';
  for (const fn of (docListeners.get('visibilitychange') || [])) fn();
  assert.equal(clock.hasInterval(), true, 'visible document restores interval');

  // IntersectionObserver out of view pauses and resumes
  if (observerCallback) {
    observerCallback([{ isIntersecting: false }]);
    assert.equal(clock.hasInterval(), false, 'out of viewport stops interval');

    observerCallback([{ isIntersecting: true }]);
    assert.equal(clock.hasInterval(), true, 'back in viewport restores interval');
  }

  // prefers-reduced-motion: true clears interval and uses auto behavior
  mediaQuery.matches = true;
  for (const listener of mediaListeners) listener();
  assert.equal(clock.hasInterval(), false, 'reduced-motion: true clears interval');

  mediaQuery.matches = false;
  for (const listener of mediaListeners) listener();
  assert.equal(clock.hasInterval(), true, 'reduced-motion: false restores interval');

  // Late API re-init / update deduplication and single step verification:
  // Add new card, call multiple inits and direct instance.update() calls
  const card5 = new Element('article', 'case-box');
  track.append(card5);
  track.scrollLeft = 0;

  const reinit1 = window.RemgazCaseCarousel.init(container);
  const reinit2 = window.RemgazCaseCarousel.init(container);
  instance.update();
  instance.update();
  assert.equal(reinit1, instance, 're-init 1 returns existing instance');
  assert.equal(reinit2, instance, 're-init 2 returns existing instance');
  assert.equal(clock.hasInterval(), true, 'timer still active after multiple re-inits and updates');

  // Advance clock: verify exactly one step happens after 7000ms (no timer duplication)
  clock.advance(7000);
  const singleStepPosition = track.scrollLeft;
  assert.equal(singleStepPosition, 316, 'multiple inits/updates produce exactly one step of 316px');
  clock.advance(6900);
  assert.equal(track.scrollLeft, singleStepPosition, 'no premature second step before another 7000ms');
  clock.advance(200);
  assert.equal(track.scrollLeft, singleStepPosition * 2, 'second step happens only after full 7000ms');

  // Destroy stops everything
  instance.destroy();
  assert.equal(clock.hasInterval(), false, 'destroy clears interval');
  assert.equal(container.dataset.carouselActive, '', 'carouselActive removed on destroy');
});
