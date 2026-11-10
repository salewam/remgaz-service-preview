(() => {
  'use strict';

  const ready = new Map();
  const pending = new Map();
  const maxReady = 18;

  function source(original, mode = 'view') {
    if (new URL(original, document.baseURI).pathname.startsWith('/media/')) return original;
    const width = window.innerWidth;
    const variant = mode === 'thumb' || mode === 'mobile' || mode === 'tablet' ? mode
      : width <= 600 ? 'mobile' : width <= 1100 ? 'tablet'
        : mode === 'large' ? 'lightbox' : 'view';
    return original.replace(/\.webp(?=$|[?#])/i, `-${variant}.webp`);
  }
  function display(image, src) {
    image.src = src;
    if (image.parentElement?.localName === 'picture') {
      for (const variant of image.parentElement.querySelectorAll('source')) variant.remove();
    }
  }

  function load(src, priority = 'auto') {
    const url = new URL(src, document.baseURI).href;
    if (ready.has(url)) {
      const image = ready.get(url);
      ready.delete(url);
      ready.set(url, image);
      return Promise.resolve(image);
    }
    if (pending.has(url)) {
      const entry = pending.get(url);
      if (priority === 'high' || (priority === 'auto' && entry.image.fetchPriority === 'low')) {
        entry.image.fetchPriority = priority;
      }
      return entry.promise;
    }

    const image = new Image();
    image.decoding = 'async';
    image.fetchPriority = priority;
    const promise = new Promise((resolve, reject) => {
      image.onload = () => image.decode().then(() => resolve(image), reject);
      image.onerror = () => reject(new Error(`Не удалось загрузить фото: ${url}`));
      image.src = url;
    }).then(result => {
      pending.delete(url);
      image.onload = image.onerror = null;
      ready.set(url, result);
      if (ready.size > maxReady) ready.delete(ready.keys().next().value);
      return result;
    }, error => {
      pending.delete(url);
      image.onload = image.onerror = null;
      throw error;
    });
    pending.set(url, { image, promise });
    return promise;
  }

  function prefetch(sources) {
    for (const src of new Set(sources)) load(src, 'low').catch(() => {});
  }

  window.RemgazPhotos = { source, load, prefetch, display };
})();
