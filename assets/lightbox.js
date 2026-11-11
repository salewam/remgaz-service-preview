(() => {
  'use strict';

  let overlay;
  let content;
  let stage;
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

  function arrowIcon(direction) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', direction === 'prev' ? 'M15 4 7 12l8 8' : 'm9 4 8 8-8 8');
    svg.append(path);
    return svg;
  }

  function createLightbox() {
    const style = document.createElement('style');
    style.textContent = `
      .rg-lightbox {
        position: fixed; inset: 0; z-index: 2147483647;
        box-sizing: border-box; display: grid; grid-template-rows: minmax(0, 1fr);
        padding-top: calc(64px + env(safe-area-inset-top)); overflow: hidden;
        background: rgba(9, 13, 18, .96); color: #fff;
        touch-action: pan-y pinch-zoom; overscroll-behavior: contain;
      }
      .rg-lightbox[hidden] { display: none; }
      .rg-lightbox__content {
        display: grid; grid-template-rows: minmax(64px, 1fr) max-content;
        min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
      }
      .rg-lightbox__stage {
        position: relative; display: flex; align-items: center; justify-content: center;
        min-width: 0; min-height: 0; padding: 0 16px; overflow: hidden;
      }
      .rg-lightbox__caption {
        box-sizing: border-box; display: flex; flex-direction: column; justify-content: safe flex-end;
        min-width: 0; min-height: calc(70px + env(safe-area-inset-bottom)); gap: 6px;
        padding: 0 max(16px, env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
      }
      .rg-lightbox__image {
        display: block; max-width: 100%; max-height: 100%; width: auto; height: auto;
        object-fit: contain; box-shadow: 0 8px 36px rgba(0, 0, 0, .35);
      }
      .rg-lightbox__close {
        position: absolute; top: calc(10px + env(safe-area-inset-top));
        right: calc(10px + env(safe-area-inset-right)); z-index: 2;
        display: grid; place-items: center; width: 52px; height: 52px;
        padding: 0; border: 0; border-radius: 50%; background: #fff; color: #111;
        cursor: pointer;
      }
      .rg-lightbox__close svg {
        display: block; width: 36px; height: 36px; fill: none; stroke: currentColor; stroke-width: 1.5;
      }
      .rg-lightbox--gallery .rg-lightbox__stage { padding-left: 72px; padding-right: 72px; }
      @media (max-width: 600px) {
        .rg-lightbox--gallery .rg-lightbox__stage { padding-left: 12px; padding-right: 12px; }
      }
      .rg-lightbox__close:focus-visible { outline: 3px solid #7dc9ff; outline-offset: 3px; }
      .rg-lightbox__title, .rg-lightbox__status, .rg-lightbox__count {
        flex: none; min-width: 0; margin: 0; overflow-wrap: anywhere;
        text-align: center; font: 16px/1.4 Arial, sans-serif;
        text-shadow: 0 1px 5px #000;
      }
      .rg-lightbox__status:empty { display: none; }
      .rg-lightbox__count[hidden] { display: none; }
    `;
    document.head.append(style);

    overlay = document.createElement('div');
    overlay.className = 'rg-lightbox';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'rg-lightbox-title');
    overlay.hidden = true;

    content = document.createElement('div');
    content.className = 'rg-lightbox__content';
    stage = document.createElement('div');
    stage.className = 'rg-lightbox__stage';
    const caption = document.createElement('div');
    caption.className = 'rg-lightbox__caption';

    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'rg-lightbox__close';
    closeButton.setAttribute('aria-label', 'Закрыть фотографию');
    const closeIcon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    closeIcon.setAttribute('viewBox', '0 0 24 24');
    closeIcon.setAttribute('aria-hidden', 'true');
    closeIcon.setAttribute('focusable', 'false');
    const closePath = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    closePath.setAttribute('d', 'M6 6 18 18M18 6 6 18');
    closeIcon.append(closePath);
    closeButton.append(closeIcon);
    previousButton = document.createElement('button');
    previousButton.type = 'button';
    previousButton.className = 'rg-lightbox__arrow rg-lightbox__prev photo-gallery-arrow photo-gallery-arrow--prev';
    previousButton.setAttribute('aria-label', 'Предыдущее фото');
    previousButton.append(arrowIcon('prev'));
    previousButton.hidden = true;

    nextButton = document.createElement('button');
    nextButton.type = 'button';
    nextButton.className = 'rg-lightbox__arrow rg-lightbox__next photo-gallery-arrow photo-gallery-arrow--next';
    nextButton.setAttribute('aria-label', 'Следующее фото');
    nextButton.append(arrowIcon('next'));
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

    stage.append(previousButton, nextButton);
    caption.append(status, count, heading);
    content.append(stage, caption);
    overlay.append(closeButton, content);
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
      if (event.target === overlay || event.target === content || event.target === stage) closeLightbox();
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
    if (link.dataset.lightboxPhotos) return displayedGallerySlides(link);
    const thumbs = link.id === 'dvImageLink'
      ? document.querySelectorAll('#dvGalleryThumbs .dv-gallery-thumb img')
      : link.matches('.gallery-stage')
        ? link.closest('.portfolio-project')?.querySelectorAll('.gallery-thumbs .gallery-thumb img')
        : null;
    if (!thumbs) return [];
    return Array.from(thumbs, (thumb) => {
      const owner = thumb.closest('.dv-gallery-thumb, .gallery-thumb');
      const original = owner?.href || owner?.dataset.photoSrc;
      if (!original) return null;
      const url = new URL(original, document.baseURI).href;
      const preview = thumb.getAttribute('src') || thumb.dataset.src || window.RemgazPhotos.source(url, 'thumb');
      return {
        preview: new URL(preview, document.baseURI).href,
        original: url,
        previewImage: thumb,
        alt: thumb.alt || thumb.closest('.dv-gallery-thumb, .gallery-thumb')?.getAttribute('aria-label') || ''
      };
    }).filter(Boolean);
  }

  function displayedGallerySlides(link) {
    let photos;
    try { photos = JSON.parse(link.dataset.lightboxPhotos || '[]'); }
    catch { return []; }
    if (!Array.isArray(photos)) return [];
    return photos.filter(photo => typeof photo?.src === 'string').map(photo => {
      const original = new URL(photo.src, document.baseURI).href;
      return {
        original,
        preview: window.RemgazPhotos.source(original, 'thumb'),
        alt: photo.alt || 'Фотография объекта'
      };
    });
  }
  function initializeCaseGalleries() {
    const photos = window.RemgazPhotos;
    const visible = new Map();
    const observer = 'IntersectionObserver' in window
      ? new IntersectionObserver(entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          visible.get(entry.target)();
          visible.delete(entry.target);
          observer.unobserve(entry.target);
        }
      }, { rootMargin: '250px' }) : null;

    document.querySelectorAll('.case-img-wrap > a[data-lightbox-photos]').forEach(link => {
      if (link.dataset.galleryReady) return;
      const image = link.querySelector('img');
      const gallery = displayedGallerySlides(link);
      if (!image || gallery.length < 2) return;
      link.dataset.galleryReady = 'true';

      const wrapper = link.parentElement;
      const project = wrapper.closest('.case-box')?.querySelector('.case-body h3')?.textContent.trim() || image.alt;
      const message = document.createElement('span');
      message.className = 'case-gallery-status';
      message.setAttribute('role', 'status');
      message.hidden = true;
      let displayedIndex = gallery.findIndex(slide => slide.original === link.href);
      if (displayedIndex < 0) return;
      let requestedIndex = displayedIndex;
      let frameRequestId = 0;

      function warmNeighbors(index) {
        const adjacent = new Set([(index + 1) % gallery.length, (index - 1 + gallery.length) % gallery.length]);
        photos.prefetch(Array.from(adjacent).flatMap(next => [
          gallery[next].preview, photos.source(gallery[next].original)
        ]));
      }

      function display(index, src) {
        const slide = gallery[index];
        photos.display(image, src);
        image.alt = slide.alt;
        link.href = slide.original;
        link.dataset.lightboxSrc = photos.source(slide.original, 'large');
        link.setAttribute('aria-label', `Открыть крупнее: ${slide.alt}`);
        displayedIndex = index;
      }

      function selectFrame(index) {
        requestedIndex = index;
        const id = ++frameRequestId;
        message.textContent = '';
        message.hidden = true;
        const slide = gallery[index];
        const sharpSource = photos.source(slide.original);
        if (index === displayedIndex && image.currentSrc === new URL(sharpSource, document.baseURI).href) {
          if (image.complete) {
            if (!image.naturalWidth) {
              message.textContent = 'Не удалось загрузить фото. Попробуйте ещё раз.';
              message.hidden = false;
            }
            warmNeighbors(index);
          } else {
            const warm = () => { if (id === frameRequestId) warmNeighbors(index); };
            image.addEventListener('load', warm, { once: true });
            image.addEventListener('error', () => {
              if (id !== frameRequestId) return;
              message.textContent = 'Не удалось загрузить фото. Попробуйте ещё раз.';
              message.hidden = false;
              warmNeighbors(index);
            }, { once: true });
          }
          return;
        }
        let sharpShown = false;
        let sharpFailed = false;
        let previewFailed = false;

        if (index !== displayedIndex) {
          photos.load(slide.preview, 'high').then(preview => {
            if (id !== frameRequestId || sharpShown) return;
            display(index, preview.src);
            if (sharpFailed) {
              message.textContent = 'Чёткий снимок недоступен — показан предпросмотр.';
              message.hidden = false;
            }
          }).catch(() => {
            if (id !== frameRequestId || sharpShown) return;
            previewFailed = true;
            if (sharpFailed) {
              requestedIndex = displayedIndex;
              message.textContent = 'Не удалось загрузить фото. Попробуйте ещё раз.';
              message.hidden = false;
            }
          });
        }

        photos.load(sharpSource, 'high').then(sharp => {
          if (id !== frameRequestId) return;
          sharpShown = true;
          display(index, sharp.src);
          message.textContent = '';
          message.hidden = true;
          warmNeighbors(index);
        }).catch(() => {
          if (id !== frameRequestId) return;
          sharpFailed = true;
          if (index === displayedIndex) {
            message.textContent = 'Чёткий снимок недоступен — показан предпросмотр.';
            message.hidden = false;
          } else if (previewFailed) {
            requestedIndex = displayedIndex;
            message.textContent = 'Не удалось загрузить фото. Попробуйте ещё раз.';
            message.hidden = false;
          }
          warmNeighbors(requestedIndex);
        });
      }

      function arrow(step, direction) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `case-gallery-arrow case-gallery-${direction} photo-gallery-arrow photo-gallery-arrow--${direction}`;
        button.setAttribute('aria-label', `${step < 0 ? 'Предыдущее' : 'Следующее'} фото: ${project}`);
        button.append(arrowIcon(direction));
        button.addEventListener('click', () => selectFrame((requestedIndex + step + gallery.length) % gallery.length));
        return button;
      }

      wrapper.append(arrow(-1, 'prev'), arrow(1, 'next'), message);
      link.addEventListener('lightbox:navigate', event => selectFrame(event.detail.index));
      if (observer) {
        visible.set(wrapper, () => selectFrame(displayedIndex));
        observer.observe(wrapper);
      } else selectFrame(displayedIndex);
    });
  }

  (window.RemgazContent?.ready || Promise.resolve()).then(initializeCaseGalleries);


  function showFrame(preview, original) {
    const id = ++requestId;
    const photos = window.RemgazPhotos;
    const sharpSource = photos.source(original, 'large');
    status.textContent = '';
    let sharpShown = false;
    let sharpFailed = false;
    let previewShown = false;
    let previewFailed = false;

    function display(src) {
      const image = document.createElement('img');
      image.className = 'rg-lightbox__image';
      image.alt = preview.alt || '';
      image.draggable = false;
      image.src = src;
      if (picture) picture.replaceWith(image);
      else stage.prepend(image);
      picture = image;
    }

    if (preview.available) {
      display(preview.src);
      previewShown = true;
    } else photos.load(preview.src, 'high').then(image => {
      if (!open || id !== requestId || sharpShown) return;
      display(image.src);
      previewShown = true;
      if (sharpFailed) status.textContent = 'Крупный снимок недоступен — показан предпросмотр.';
    }).catch(() => {
      if (!open || id !== requestId || sharpShown) return;
      previewFailed = true;
      status.textContent = sharpFailed
        ? 'Не удалось загрузить фото. Попробуйте ещё раз.'
        : 'Не удалось загрузить предпросмотр. Ожидаем крупный снимок.';
    });

    photos.load(sharpSource, 'high').then(image => {
      if (!open || id !== requestId) return;
      sharpShown = true;
      display(image.src);
      status.textContent = '';
      warmLightboxNeighbors();
    }).catch(() => {
      if (!open || id !== requestId) return;
      sharpFailed = true;
      status.textContent = previewFailed
        ? 'Не удалось загрузить фото. Попробуйте ещё раз.'
        : previewShown ? 'Крупный снимок недоступен — показан предпросмотр.'
          : 'Крупный снимок недоступен — ожидаем предпросмотр.';
      warmLightboxNeighbors();
    });
  }

  function warmLightboxNeighbors() {
    if (slides.length < 2) return;
    const adjacent = new Set([(slideIndex + 1) % slides.length, (slideIndex - 1 + slides.length) % slides.length]);
    window.RemgazPhotos.prefetch(Array.from(adjacent).flatMap(index => [
      slides[index].preview, window.RemgazPhotos.source(slides[index].original, 'large')
    ]));
  }

  function navigate(step) {
    if (!open || slides.length < 2) return;
    slideIndex = (slideIndex + step + slides.length) % slides.length;
    const slide = slides[slideIndex];
    count.textContent = `Фото ${slideIndex + 1} из ${slides.length}`;
    heading.textContent = slide.alt || 'Просмотр фотографий';
    heading.title = heading.textContent;
    showFrame({ src: slide.preview, alt: slide.alt,
      available: slide.previewImage?.complete && slide.previewImage.naturalWidth > 0 }, slide.original);
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
      slides = displayedGallerySlides(link);
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
    heading.textContent = gallery ? slides[slideIndex].alt || 'Просмотр фотографий'
      : link.getAttribute('aria-label') || preview.alt || 'Просмотр фотографии';
    heading.title = heading.textContent;
    showFrame({ src: preview.currentSrc || preview.src, alt: preview.alt, available: true },
      gallery ? slides[slideIndex].original : link.href);

    if (!open) {
      lockPage();
      open = true;
      overlay.hidden = false;
      content.scrollTop = 0;
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
