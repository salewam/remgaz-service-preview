(() => {
  'use strict';

  let overlay;
  let picture;
  let heading;
  let status;
  let closeButton;
  let previousButton;
  let nextButton;
  let count;
  let slides = [];
  let slideIndex = 0;
  let sourceLink;
  let detachedGallery = false;
  let touchStart;
  let open = false;
  let requestId = 0;
  let previousFocus;
  let previousScroll;
  let previousStyles;
  let inertElements;

  function createLightbox() {
    const style = document.createElement('style');
    style.textContent = `
      .rg-lightbox {
        position: fixed; inset: 0; z-index: 2147483647;
        box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        padding: calc(64px + env(safe-area-inset-top)) 16px calc(70px + env(safe-area-inset-bottom));
        background: rgba(9, 13, 18, .96); color: #fff;
        touch-action: pan-y pinch-zoom; overscroll-behavior: contain;
      }
      .rg-lightbox[hidden] { display: none; }
      .rg-lightbox__image {
        display: block; max-width: 100%; max-height: 100%; width: auto; height: auto;
        object-fit: contain; box-shadow: 0 8px 36px rgba(0, 0, 0, .35);
      }
      .rg-lightbox__close {
        position: absolute; top: calc(10px + env(safe-area-inset-top));
        right: calc(10px + env(safe-area-inset-right)); z-index: 1;
        display: grid; place-items: center; width: 52px; height: 52px;
        padding: 0; border: 0; border-radius: 50%; background: #fff; color: #111;
        font: 36px/1 Arial, sans-serif; cursor: pointer;
      }
      .rg-lightbox__arrow {
        position: absolute; top: 50%; z-index: 1; transform: translateY(-50%);
        display: grid; place-items: center; width: 52px; height: 52px;
        padding: 0; border: 0; border-radius: 50%;
        background: rgba(255, 255, 255, .93); color: #111;
        font: 38px/1 Arial, sans-serif; cursor: pointer;
      }
      .rg-lightbox__arrow[hidden] { display: none; }
      .rg-lightbox__prev { left: calc(12px + env(safe-area-inset-left)); }
      .rg-lightbox__next { right: calc(12px + env(safe-area-inset-right)); }
      .rg-lightbox__arrow:focus-visible { outline: 3px solid #7dc9ff; outline-offset: 3px; }
      .rg-lightbox--gallery { padding-left: 72px; padding-right: 72px; }
      @media (max-width: 600px) {
        .rg-lightbox--gallery { padding-left: 12px; padding-right: 12px; }
      }
      .rg-lightbox__close:focus-visible { outline: 3px solid #7dc9ff; outline-offset: 3px; }
      .rg-lightbox__title, .rg-lightbox__status, .rg-lightbox__count {
        position: absolute; left: 16px; right: 16px; margin: 0;
        text-align: center; font: 16px/1.4 Arial, sans-serif;
        text-shadow: 0 1px 5px #000;
      }
      .rg-lightbox__title { bottom: calc(14px + env(safe-area-inset-bottom)); }
      .rg-lightbox__count { bottom: calc(42px + env(safe-area-inset-bottom)); }
      .rg-lightbox__count[hidden] { display: none; }
      .rg-lightbox__status { bottom: calc(70px + env(safe-area-inset-bottom)); }
    `;
    document.head.append(style);

    overlay = document.createElement('div');
    overlay.className = 'rg-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rg-lightbox-title');
    overlay.hidden = true;

    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'rg-lightbox__close';
    closeButton.setAttribute('aria-label', 'Закрыть фотографию');
    closeButton.textContent = '×';
    previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'rg-lightbox__arrow rg-lightbox__prev';
    previousButton.setAttribute('aria-label', 'Предыдущее фото');
    previousButton.textContent = '‹';
    previousButton.hidden = true;

    nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'rg-lightbox__arrow rg-lightbox__next';
    nextButton.setAttribute('aria-label', 'Следующее фото');
    nextButton.textContent = '›';
    nextButton.hidden = true;

    count = document.createElement('p');
    count.className = 'rg-lightbox__count';
    count.setAttribute('aria-live', 'polite');
    count.hidden = true;

    heading = document.createElement('p');
    heading.id = 'rg-lightbox-title';
    heading.className = 'rg-lightbox__title';

    status = document.createElement('p');
    status.className = 'rg-lightbox__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    overlay.append(closeButton, previousButton, nextButton, heading, count, status);
    document.body.append(overlay);
    closeButton.addEventListener('click', closeLightbox);
    previousButton.addEventListener('click', () => navigate(-1));
    nextButton.addEventListener('click', () => navigate(1));
    overlay.addEventListener('touchstart', (event) => {
      touchStart = event.touches.length === 1 && !event.target.closest('button')
        ? { x: event.touches[0].clientX, y: event.touches[0].clientY }
        : null;
    }, { passive: true });
    overlay.addEventListener('touchend', (event) => {
      if (!touchStart || event.changedTouches.length !== 1 || event.touches.length) {
        touchStart = null;
        return;
      }
      const dx = event.changedTouches[0].clientX - touchStart.x;
      const dy = event.changedTouches[0].clientY - touchStart.y;
      touchStart = null;
      if (Math.abs(dx) >= 50 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate(dx < 0 ? 1 : -1);
    }, { passive: true });
    overlay.addEventListener('touchcancel', () => { touchStart = null; });
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeLightbox();
    });
  }

  function lockPage() {
    previousFocus = document.activeElement;
    previousScroll = { x: window.scrollX, y: window.scrollY };
    const body = document.body;
    const root = document.documentElement;
    previousStyles = {
      position: body.style.getPropertyValue('position'),
      positionPriority: body.style.getPropertyPriority('position'),
      top: body.style.getPropertyValue('top'),
      topPriority: body.style.getPropertyPriority('top'),
      left: body.style.getPropertyValue('left'),
      leftPriority: body.style.getPropertyPriority('left'),
      right: body.style.getPropertyValue('right'),
      rightPriority: body.style.getPropertyPriority('right'),
      width: body.style.getPropertyValue('width'),
      widthPriority: body.style.getPropertyPriority('width'),
      overflow: root.style.getPropertyValue('overflow'),
      overflowPriority: root.style.getPropertyPriority('overflow')
    };
    body.style.setProperty('position', 'fixed');
    body.style.setProperty('top', `-${previousScroll.y}px`);
    body.style.setProperty('left', `-${previousScroll.x}px`);
    body.style.setProperty('right', '0');
    body.style.setProperty('width', '100%');
    root.style.setProperty('overflow', 'hidden');

    inertElements = [];
    for (const element of body.children) {
      if (element === overlay) continue;
      inertElements.push([element, element.inert]);
      element.inert = true;
    }
  }

  function restorePage() {
    for (const [element, wasInert] of inertElements) element.inert = wasInert;
    inertElements = null;
    const body = document.body;
    const root = document.documentElement;
    for (const property of ['position', 'top', 'left', 'right', 'width']) {
      if (previousStyles[property]) {
        body.style.setProperty(property, previousStyles[property], previousStyles[`${property}Priority`]);
      } else {
        body.style.removeProperty(property);
      }
    }
    if (previousStyles.overflow) {
      root.style.setProperty('overflow', previousStyles.overflow, previousStyles.overflowPriority);
    } else {
      root.style.removeProperty('overflow');
    }
    window.scrollTo({ left: previousScroll.x, top: previousScroll.y, behavior: 'instant' });
    if (previousFocus?.isConnected && typeof previousFocus.focus === 'function') {
      previousFocus.focus({ preventScroll: true });
    }
  }

  function closeLightbox() {
    if (!open) return;
    open = false;
    ++requestId;
    slides = [];
    sourceLink = null;
    touchStart = null;
    overlay.hidden = true;
    picture.remove();
    picture = null;
    restorePage();
  }

  function gallerySlides(link) {
    const thumbs = link.id === 'dvImageLink'
      ? document.querySelectorAll('#dvGalleryThumbs .dv-gallery-thumb img')
      : link.matches('.gallery-stage')
        ? link.closest('.portfolio-project')?.querySelectorAll('.gallery-thumbs .gallery-thumb img')
        : null;
    if (!thumbs) return [];
    return Array.from(thumbs, (thumb) => {
      const preview = thumb.getAttribute('src') || thumb.dataset.src;
      if (!preview || !/-thumb\.webp(?=$|[?#])/i.test(preview)) return null;
      const url = new URL(preview, document.baseURI).href;
      return {
        preview: url,
        original: url.replace(/-thumb\.webp(?=$|[?#])/i, '.webp'),
        large: url.replace(/-thumb\.webp(?=$|[?#])/i, '-lightbox.webp'),
        alt: thumb.alt || thumb.closest('.dv-gallery-thumb, .gallery-thumb')?.getAttribute('aria-label') || ''
      };
    }).filter(Boolean);
  }

  function displayedGallerySlides(link) {
    const match = link.href.match(/^(.*-)(\d+)\.webp$/i);
    const ids = link.dataset.lightboxPhotos?.split(',').map(id => id.trim());
    if (!match || !ids?.length || !ids.every(id => /^\d+$/.test(id))) return [];
    return ids.map((id, index) => {
      const original = `${match[1]}${id.padStart(match[2].length, '0')}.webp`;
      return {
        original,
        preview: original.replace(/\.webp$/i, '-thumb.webp'),
        large: original.replace(/\.webp$/i, '-lightbox.webp'),
        alt: `Фото ${index + 1} из ${ids.length}`
      };
    });
  }

  function showFrame(preview, largeSource) {
    const id = ++requestId;
    const image = document.createElement('img');
    image.className = 'rg-lightbox__image';
    image.alt = preview.alt || '';
    image.draggable = false;
    image.src = preview.src;
    if (picture) picture.replaceWith(image);
    else overlay.insertBefore(image, heading);
    picture = image;
    status.textContent = '';

    if (!largeSource) return;
    const large = new Image();
    large.className = 'rg-lightbox__image';
    large.alt = image.alt;
    large.draggable = false;
    large.decoding = 'async';
    large.src = largeSource;
    large.decode().then(() => {
      if (!open || id !== requestId) return;
      image.replaceWith(large);
      picture = large;
    }).catch(() => {
      if (open && id === requestId) {
        status.textContent = 'Крупный снимок недоступен — показан предпросмотр.';
      }
    });
  }

  function navigate(step) {
    if (!open || slides.length < 2) return;
    slideIndex = (slideIndex + step + slides.length) % slides.length;
    const slide = slides[slideIndex];
    count.textContent = `Фото ${slideIndex + 1} из ${slides.length}`;
    showFrame({ src: slide.preview, alt: slide.alt }, slide.large);
    if (!detachedGallery) {
      sourceLink.dispatchEvent(new CustomEvent('lightbox:navigate', { detail: { index: slideIndex } }));
    }
  }

  function showLightbox(link) {
    const preview = link.querySelector('img');
    if (!preview) return;
    if (!overlay) createLightbox();

    sourceLink = link;
    slides = gallerySlides(link);
    detachedGallery = false;
    slideIndex = slides.findIndex(slide => slide.original === link.href);
    if (slideIndex < 0) {
      slides = link.id === 'dvImageLink' ? displayedGallerySlides(link) : [];
      slideIndex = slides.findIndex(slide => slide.original === link.href);
      detachedGallery = slideIndex >= 0;
      if (slideIndex < 0) slides = [];
    }
    const gallery = slides.length > 1;
    overlay.classList.toggle('rg-lightbox--gallery', gallery);
    previousButton.hidden = !gallery;
    nextButton.hidden = !gallery;
    count.hidden = !gallery;
    count.textContent = gallery ? `Фото ${slideIndex + 1} из ${slides.length}` : '';
    heading.textContent = gallery ? 'Просмотр фотографий'
      : link.getAttribute('aria-label') || preview.alt || 'Просмотр фотографии';
    showFrame({ src: preview.currentSrc || preview.src, alt: preview.alt },
      gallery ? slides[slideIndex].large : link.getAttribute('data-lightbox-src'));

    if (!open) {
      lockPage();
      open = true;
      overlay.hidden = false;
    }
    closeButton.focus({ preventScroll: true });
  }

  document.addEventListener('click', (event) => {
    const link = event.target.closest?.('a[data-lightbox]');
    if (!link) return;
    event.preventDefault();
    showLightbox(link);
  });
  document.addEventListener('keydown', (event) => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeLightbox();
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (slides.length < 2) return;
      event.preventDefault();
      navigate(event.key === 'ArrowRight' ? 1 : -1);
    } else if (event.key === 'Tab') {
      event.preventDefault();
      const buttons = slides.length > 1 ? [closeButton, previousButton, nextButton] : [closeButton];
      const current = buttons.indexOf(document.activeElement);
      const next = current < 0 ? (event.shiftKey ? buttons.length - 1 : 0)
        : (current + (event.shiftKey ? buttons.length - 1 : 1)) % buttons.length;
      buttons[next].focus({ preventScroll: true });
    }
  });
})();
