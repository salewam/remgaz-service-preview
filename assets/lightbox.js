(() => {
  'use strict';

  let overlay;
  let picture;
  let heading;
  let status;
  let closeButton;
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
      .rg-lightbox__close:focus-visible { outline: 3px solid #7dc9ff; outline-offset: 3px; }
      .rg-lightbox__title, .rg-lightbox__status {
        position: absolute; left: 16px; right: 16px; margin: 0;
        text-align: center; font: 16px/1.4 Arial, sans-serif;
        text-shadow: 0 1px 5px #000;
      }
      .rg-lightbox__title { bottom: calc(14px + env(safe-area-inset-bottom)); }
      .rg-lightbox__status { bottom: calc(42px + env(safe-area-inset-bottom)); }
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

    heading = document.createElement('p');
    heading.id = 'rg-lightbox-title';
    heading.className = 'rg-lightbox__title';

    status = document.createElement('p');
    status.className = 'rg-lightbox__status';
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');

    overlay.append(closeButton, heading, status);
    document.body.append(overlay);
    closeButton.addEventListener('click', closeLightbox);
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
    overlay.hidden = true;
    picture.remove();
    picture = null;
    restorePage();
  }

  function showLightbox(link) {
    const preview = link.querySelector('img');
    if (!preview) return;
    if (!overlay) createLightbox();

    const id = ++requestId;
    const image = document.createElement('img');
    image.className = 'rg-lightbox__image';
    image.alt = preview.alt || '';
    image.draggable = false;
    image.src = preview.currentSrc || preview.src;
    if (picture) picture.replaceWith(image);
    else overlay.insertBefore(image, heading);
    picture = image;
    heading.textContent = link.getAttribute('aria-label') || preview.alt || 'Просмотр фотографии';
    status.textContent = '';

    if (!open) {
      lockPage();
      open = true;
      overlay.hidden = false;
    }
    closeButton.focus({ preventScroll: true });

    const source = link.getAttribute('data-lightbox-src');
    if (!source) return;
    const large = new Image();
    large.className = 'rg-lightbox__image';
    large.alt = image.alt;
    large.draggable = false;
    large.decoding = 'async';
    large.src = source;
    large.decode().then(() => {
      if (!open || id !== requestId) return;
      image.replaceWith(large);
      picture = large;
    }).catch(() => {
      if (open && id === requestId) {
        status.textContent = 'Полный размер недоступен — показан предпросмотр.';
      }
    });
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
    } else if (event.key === 'Tab') {
      event.preventDefault();
      closeButton.focus({ preventScroll: true });
    }
  });
})();
