(() => {
  'use strict';

  const assetsBase = new URL('.', document.currentScript.src);
  const apiURL = new URL(document.querySelector('meta[name="remgaz-content-api"]')?.content || '/api/content', document.baseURI);
  const seedURL = new URL('content/site.json', document.baseURI);
  const loader = window.RemgazPhotos;
  const priceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

  function photoURL(src) {
    if (typeof src !== 'string') throw new Error('Некорректный адрес фотографии');
    if (/^assets\/portfolio\/[a-zA-Z0-9_-]+\.webp$/.test(src)) {
      return new URL(src.slice(src.indexOf('/') + 1), assetsBase).href;
    }
    if (/^\/media\/[a-f0-9]{64}\.webp$/.test(src)) return new URL(src, apiURL.origin).href;
    throw new Error('Некорректный адрес фотографии');
  }

  function prepare(content) {
    if (!content || !Number.isInteger(content.revision) || content.revision < 1
      || !Number.isFinite(content.gasPriceRub) || content.gasPriceRub <= 0 || !Array.isArray(content.projects)) {
      throw new Error('Некорректные данные сайта');
    }
    const ids = new Set();
    const projects = content.projects.filter(project => project?.published === true).map(project => {
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(project.id) || ids.has(project.id)
        || !['title', 'loc', 'desc', 'task', 'work'].every(key => typeof project[key] === 'string')
        || !project.title.trim() || !Array.isArray(project.tags) || !project.tags.every(tag => typeof tag === 'string')
        || !Array.isArray(project.facts) || !project.facts.every(fact => typeof fact?.label === 'string' && typeof fact.value === 'string')
        || !Array.isArray(project.photos) || !project.photos.length) {
        throw new Error('Некорректные данные проекта');
      }
      ids.add(project.id);
      const photos = project.photos.map(photo => {
        if (typeof photo?.alt !== 'string' || !Number.isInteger(photo.width) || photo.width <= 0
          || !Number.isInteger(photo.height) || photo.height <= 0) throw new Error('Некорректные данные фотографии');
        return { ...photo, src: photoURL(photo.src) };
      });
      const coverPhoto = photoURL(project.coverPhoto);
      if (!photos.some(photo => photo.src === coverPhoto)) throw new Error('Обложка отсутствует в проекте');
      return { ...project, photos, coverPhoto };
    });
    return { revision: content.revision, gasPriceRub: content.gasPriceRub, projects };
  }

  async function fetchContent(url) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { cache: 'no-cache', credentials: 'omit', signal: controller.signal });
      if (!response.ok) {
        const error = new Error('Данные сайта недоступны');
        error.status = response.status;
        throw error;
      }
      return prepare(await response.json());
    } finally {
      clearTimeout(timeout);
    }
  }

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function updateText(parent, selector, text) {
    const node = parent.querySelector(selector);
    if (node && node.textContent !== text) node.textContent = text;
  }

  function cover(project) {
    return project.photos.find(photo => photo.src === project.coverPhoto);
  }

  function updateStage(link, project) {
    const photo = cover(project);
    const image = link.querySelector('img');
    const unchanged = link.href === photo.src;
    link.href = photo.src;
    link.dataset.lightboxSrc = loader.source(photo.src, 'large');
    link.dataset.lightboxPhotos = JSON.stringify(project.photos);
    if (!unchanged) loader.display(image, loader.source(photo.src));
    image.alt = photo.alt;
    link.setAttribute('aria-label', `Открыть крупнее: ${photo.alt || project.title}`);
  }

  function renderPrices(value) {
    const price = value === null ? '—' : priceFormat.format(value);
    document.querySelectorAll('[data-gas-price]').forEach(node => {
      if (node.dataset.gasPrice === 'number') {
        const unit = node.querySelector('span');
        node.replaceChildren(document.createTextNode(`${price} `), unit);
      } else node.textContent = `${price} ₽/л`;
    });
  }

  function renderUnavailable() {
    renderPrices(null);
    const message = () => {
      const panel = element('div');
      panel.dataset.contentError = '';
      panel.style.gridColumn = '1 / -1';
      panel.setAttribute('role', 'status');
      const text = element('p', 'sec-desc', 'Не удалось загрузить актуальные данные. Обновите страницу.');
      const reload = element('button', document.querySelector('#price .price-heading') ? 'btn-primary' : 'btn-primary-lead', 'Обновить');
      reload.type = 'button';
      reload.addEventListener('click', () => location.reload());
      panel.append(text, reload);
      return panel;
    };
    document.querySelectorAll('.object-matrix, .case-triad, .project-list').forEach(container => {
      container.replaceChildren(message());
    });
    document.querySelector('.intro-index')?.replaceChildren();
    const details = document.getElementById('detailDrawer');
    if (details) details.hidden = true;
    document.querySelector('#price .price-heading')?.append(message());
    updateText(document, '#projects > h2', 'Портфолио');
    updateText(document, '.intro-content > p', 'Проекты временно недоступны. Обновите страницу или свяжитесь с нами.');
  }

  function renderCards(projects) {
    document.querySelectorAll('.case-box[data-project-id]').forEach(card => {
      const project = projects.find(item => item.id === card.dataset.projectId);
      if (!project) {
        card.remove();
        return;
      }
      updateText(card, '.case-kicker', project.loc);
      updateText(card, '.case-body h3 a', project.title);
      card.querySelector('.case-body h3 a').href = `portfolio.html#${project.id}`;
      updateText(card, '.case-body > p', project.cardDesc || project.desc);
      updateText(card, '.case-params', project.facts.map(fact => `${fact.label} — ${fact.value}`).join(' · '));
      updateStage(card.querySelector('.case-img-wrap > a'), project);
    });
  }

  function createProject(project, index) {
    const article = element('article', 'portfolio-project');
    article.id = project.id;
    const gallery = element('div', 'project-gallery');
    const stage = element('a', 'gallery-stage');
    stage.dataset.lightbox = '';
    stage.target = '_blank';
    stage.rel = 'noopener';
    const image = element('img');
    const photo = cover(project);
    image.width = photo.width;
    image.height = photo.height;
    image.loading = index === 0 ? 'eager' : 'lazy';
    image.fetchPriority = index === 0 ? 'high' : 'auto';
    image.decoding = 'async';
    stage.append(image);
    const thumbs = element('div', 'gallery-thumbs');
    thumbs.setAttribute('role', 'group');
    const count = element('p', 'gallery-count');
    count.setAttribute('aria-live', 'polite');
    gallery.append(stage, thumbs, count);
    const head = element('div', 'project-head');
    head.append(element('p', 'project-location'), element('h3'));
    const copy = element('div', 'project-copy');
    copy.append(element('p'), element('p'), element('p'), element('dl', 'project-facts'));
    article.append(gallery, head, copy);
    return article;
  }

  function renderProject(article, project) {
    updateText(article, '.project-location', project.loc);
    updateText(article, '.project-head h3', project.title);
    const paragraphs = article.querySelectorAll('.project-copy > p');
    paragraphs[0].textContent = project.desc;
    paragraphs[1].replaceChildren(element('strong', '', 'Задача:'), document.createTextNode(` ${project.task}`));
    paragraphs[2].replaceChildren(element('strong', '', 'Решение:'), document.createTextNode(` ${project.work}`));
    const facts = project.facts.map(fact => {
      const row = element('div');
      row.append(element('dt', '', fact.label), element('dd', '', fact.value));
      return row;
    });
    article.querySelector('.project-facts').replaceChildren(...facts);
    updateStage(article.querySelector('.gallery-stage'), project);
    const thumbs = article.querySelector('.gallery-thumbs');
    thumbs.setAttribute('aria-label', `Фотографии: ${project.title}`);
    thumbs.replaceChildren(...project.photos.map((photo, index) => {
      const link = element('a', 'gallery-thumb');
      link.href = photo.src;
      link.target = '_blank';
      link.rel = 'noopener';
      link.setAttribute('aria-label', photo.alt || `${project.title}: фотография ${index + 1} из ${project.photos.length}`);
      if (photo.src === project.coverPhoto) link.setAttribute('aria-current', 'true');
      const image = element('img');
      image.src = loader.source(photo.src, 'thumb');
      image.alt = photo.alt;
      image.loading = 'lazy';
      image.decoding = 'async';
      image.width = 160;
      image.height = Math.round(photo.height * 160 / photo.width);
      link.append(image);
      return link;
    }));
    const index = project.photos.findIndex(photo => photo.src === project.coverPhoto);
    article.querySelector('.gallery-count').textContent = `Фото ${index + 1} из ${project.photos.length} · стрелки или миниатюры`;
  }

  function projectCount(count) {
    const last = count % 10;
    const teens = count % 100 >= 11 && count % 100 <= 14;
    return `${count} ${!teens && last === 1 ? 'проект' : !teens && last >= 2 && last <= 4 ? 'проекта' : 'проектов'}`;
  }

  function renderPortfolio(projects) {
    const list = document.querySelector('.project-list');
    if (!list) return;
    const existing = new Map(Array.from(list.querySelectorAll('.portfolio-project'), article => [article.id, article]));
    const articles = projects.map((project, index) => {
      const article = existing.get(project.id) || createProject(project, index);
      renderProject(article, project);
      return article;
    });
    list.replaceChildren(...articles);
    const total = String(projects.length).padStart(2, '0');
    list.style.setProperty('--project-total', `"${total}"`);
    const navigation = document.querySelector('.intro-index');
    if (navigation) {
      const label = element('p', 'intro-index-label', projects.length ? `Проекты / 01—${total}` : 'Проекты');
      navigation.replaceChildren(label, ...projects.map((project, index) => {
        const link = element('a');
        link.href = `#${project.id}`;
        link.append(element('span', '', String(index + 1).padStart(2, '0')), document.createTextNode(project.navTitle || project.title));
        return link;
      }));
    }
    if (projects.length !== 7) {
      updateText(document, '#projects > h2', projectCount(projects.length));
      updateText(document, '.intro-content > p', `Газоснабжение, котельные и тепловые системы: ${projectCount(projects.length)} с фотографиями, задачей и выполненными работами.`);
    }
  }

  const content = { state: 'loading', document: null, photoURL, ready: null };
  window.RemgazContent = content;
  content.ready = (async () => {
    let data;
    try {
      data = await fetchContent(apiURL);
      content.state = 'live';
    } catch (error) {
      if (apiURL.origin === location.origin && error.status === 404) {
        try {
          data = await fetchContent(seedURL);
          content.state = 'bundled';
        } catch {
          // A static preview may use its bundled seed only when no same-origin API exists.
        }
      }
      if (!data) {
        content.state = 'unavailable';
        renderUnavailable();
        return null;
      }
    }
    renderPrices(data.gasPriceRub);
    renderCards(data.projects);
    renderPortfolio(data.projects);
    content.document = data;
    return data;
  })();
})();
