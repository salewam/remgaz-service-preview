(() => {
  'use strict';

  const instances = new WeakMap();

  function initCaseCarousel(container) {
    if (!container) return null;
    if (instances.has(container)) {
      const existing = instances.get(container);
      existing.update();
      return existing;
    }
    const track = container.querySelector('.case-carousel-track') || container.querySelector('.case-triad');
    if (!track) return null;
    container.dataset.carouselActive = 'true';

    const prevBtn = container.querySelector('.case-carousel-prev');
    const nextBtn = container.querySelector('.case-carousel-next');
    const toggleBtn = container.querySelector('.case-carousel-toggle');
    const toggleText = toggleBtn?.querySelector('.case-carousel-toggle-text');
    const status = container.querySelector('.case-carousel-status');

    let isManualPaused = false;
    let timer = null;
    let isInternalScrolling = false;
    let internalScrollTimeout = null;
    const intervalMs = 5000;

    const mediaQuery = typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
    function isReducedMotion() {
      return mediaQuery?.matches ?? false;
    }

    function getStep() {
      const card = track.querySelector('.case-box');
      if (!card) return 0;
      const cardWidth = card.getBoundingClientRect().width;
      const gap = parseFloat(getComputedStyle(track).columnGap || getComputedStyle(track).gap) || 16;
      return cardWidth + gap;
    }

    function maxScroll() {
      return Math.max(0, track.scrollWidth - track.clientWidth);
    }

    function performScroll(action) {
      isInternalScrolling = true;
      clearTimeout(internalScrollTimeout);
      action();
      internalScrollTimeout = setTimeout(() => {
        isInternalScrolling = false;
      }, 600);
    }

    function scrollByStep(direction) {
      const step = getStep() || 320;
      const max = maxScroll();
      if (max <= 0) return;
      const behavior = isReducedMotion() ? 'auto' : 'smooth';

      performScroll(() => {
        if (direction > 0) {
          if (track.scrollLeft >= max - 10) {
            track.scrollTo({ left: 0, behavior });
          } else {
            track.scrollBy({ left: step, behavior });
          }
        } else {
          if (track.scrollLeft <= 10) {
            track.scrollTo({ left: max, behavior });
          } else {
            track.scrollBy({ left: -step, behavior });
          }
        }
      });
    }

    let isIntersecting = true;
    if (typeof IntersectionObserver !== 'undefined') {
      const observer = new IntersectionObserver((entries) => {
        isIntersecting = entries[0]?.isIntersecting ?? true;
        updateTimer();
      }, { threshold: 0.1 });
      observer.observe(container);
    }

    function isPageVisible() {
      return typeof document !== 'undefined' ? document.visibilityState !== 'hidden' : true;
    }

    let isHovered = false;
    let isFocused = false;
    let isInteracting = false;
    let interactTimeout = null;

    function shouldAutoPlay() {
      if (isManualPaused) return false;
      if (isReducedMotion()) return false;
      if (!isPageVisible()) return false;
      if (!isIntersecting) return false;
      if (isHovered || isFocused || isInteracting) return false;
      return maxScroll() > 10;
    }

    function updateTimer() {
      clearInterval(timer);
      timer = null;
      if (shouldAutoPlay()) {
        timer = setInterval(() => {
          if (shouldAutoPlay()) {
            scrollByStep(1);
          }
        }, intervalMs);
      }
    }

    function pause() {
      isManualPaused = true;
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', 'true');
        toggleBtn.setAttribute('aria-label', 'Возобновить автопрокрутку портфолио');
        if (toggleText) toggleText.textContent = 'Возобновить';
      }
      if (status) status.textContent = 'Автопрокрутка приостановлена';
      updateTimer();
    }

    function play() {
      isManualPaused = false;
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', 'false');
        toggleBtn.setAttribute('aria-label', 'Приостановить автопрокрутку портфолио');
        if (toggleText) toggleText.textContent = 'Пауза';
      }
      if (status) status.textContent = 'Автопрокрутка включена';
      updateTimer();
    }

    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        if (isManualPaused) {
          play();
        } else {
          pause();
        }
      });
    }

    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        scrollByStep(-1);
      });
    }

    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        scrollByStep(1);
      });
    }

    container.addEventListener('pointerenter', () => {
      isHovered = true;
      updateTimer();
    });

    container.addEventListener('pointerleave', () => {
      isHovered = false;
      updateTimer();
    });

    container.addEventListener('focusin', () => {
      isFocused = true;
      updateTimer();
    });

    container.addEventListener('focusout', () => {
      isFocused = false;
      updateTimer();
    });

    function markUserInteraction() {
      if (isInternalScrolling) return;
      isInteracting = true;
      updateTimer();
      clearTimeout(interactTimeout);
      interactTimeout = setTimeout(() => {
        isInteracting = false;
        updateTimer();
      }, 3000);
    }

    track.addEventListener('scroll', markUserInteraction, { passive: true });
    track.addEventListener('touchstart', markUserInteraction, { passive: true });
    track.addEventListener('pointerdown', markUserInteraction, { passive: true });

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', updateTimer);
    }

    if (typeof window !== 'undefined') {
      window.addEventListener('resize', updateTimer, { passive: true });
      if (mediaQuery) {
        if (mediaQuery.addEventListener) {
          mediaQuery.addEventListener('change', updateTimer);
        } else if (mediaQuery.addListener) {
          mediaQuery.addListener(updateTimer);
        }
      }
    }

    updateTimer();

    const api = {
      play,
      pause,
      next: () => scrollByStep(1),
      prev: () => scrollByStep(-1),
      update: updateTimer,
      destroy: () => {
        clearInterval(timer);
        timer = null;
        clearTimeout(interactTimeout);
        clearTimeout(internalScrollTimeout);
        container.dataset.carouselActive = '';
        instances.delete(container);
      }
    };
    instances.set(container, api);
    return api;
  }

  window.RemgazCaseCarousel = { init: initCaseCarousel };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      document.querySelectorAll('.case-carousel-section').forEach(initCaseCarousel);
    });
  } else {
    document.querySelectorAll('.case-carousel-section').forEach(initCaseCarousel);
  }
})();
