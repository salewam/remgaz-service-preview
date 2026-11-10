(() => {
  'use strict';

  const byId = id => document.getElementById(id);
  const telegram = window.Telegram?.WebApp;
  const initData = telegram?.initData || '';
  const assetBase = new URL('.', document.currentScript.src);
  const projectForm = byId('project-form');
  const state = { document: null, draft: null, dirty: false, busy: false, tab: 'portfolio' };
  const textFields = ['title', 'loc', 'desc', 'task', 'work', 'navTitle', 'cardDesc', 'categorySummary'];
  const priceFormat = new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 });

  function photoUrl(src, thumb = false) {
    if (/^assets\//.test(src)) {
      const name = src.slice(src.indexOf('/') + 1);
      return new URL(thumb ? name.replace(/\.webp$/, '-thumb.webp') : name, assetBase).href;
    }
    return new URL(src, location.origin).href;
  }

  function status(message, error = false) {
    const element = byId('status');
    element.textContent = message;
    element.hidden = !message;
    element.classList.toggle('is-error', error);
    element.setAttribute('role', error ? 'alert' : 'status');
  }

  function markDirty(value = true) {
    state.dirty = value;
    byId('dirty-label').hidden = !value;
    if (value) telegram?.enableClosingConfirmation?.();
    else telegram?.disableClosingConfirmation?.();
  }

  function setBusy(value) {
    state.busy = value;
    byId('workspace').setAttribute('aria-busy', String(value));
    for (const element of byId('workspace').querySelectorAll('button, input, textarea')) element.disabled = value;
    if (!value && state.draft) renderPhotos();
  }

  async function request(path, { method = 'GET', json, image } = {}) {
    const headers = { Authorization: `tma ${initData}` };
    let body;
    if (json !== undefined) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json); }
    if (image) { headers['Content-Type'] = 'image/webp'; body = image; }
    let response;
    try {
      response = await fetch(path, { method, headers, body, cache: 'no-store', signal: AbortSignal.timeout(20_000) });
    } catch {
      throw new Error('Нет ответа от сервера. Проверьте соединение и повторите. Несохранённые поля остались в форме.');
    }
    let data;
    try { data = await response.json(); }
    catch { throw new Error('Сервер не подтвердил сохранение. Повторите позже.'); }
    if (!response.ok) {
      const message = response.status === 401 ? 'Срок доступа истёк. Закройте приложение и откройте снова через бота.' :
        response.status === 403 ? 'У этого аккаунта нет доступа к управлению сайтом.' :
        response.status === 409 ? 'Данные уже изменились в другом окне. Обновите данные перед сохранением. Ваши поля пока не сброшены.' :
        typeof data.error === 'string' ? data.error : 'Не удалось сохранить изменения.';
      const error = new Error(message);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function acceptDocument(data) {
    if (!data || !Number.isSafeInteger(data.revision) || !Array.isArray(data.projects) || !Number.isFinite(data.gasPriceRub)) {
      throw new Error('Сервер вернул неполные данные сайта.');
    }
    state.document = data;
    byId('current-price').textContent = `Сейчас на сайте: ${priceFormat.format(data.gasPriceRub)} ₽/л`;
    byId('gas-price').value = priceFormat.format(data.gasPriceRub).replace(/\s/g, '');
    renderProjects();
  }

  function renderProjects() {
    const list = byId('project-list');
    list.replaceChildren();
    for (const project of state.document.projects) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'project-item';
      button.dataset.projectId = project.id;
      const cover = project.coverPhoto || project.photos[0]?.src;
      if (cover) {
        const image = document.createElement('img');
        image.src = photoUrl(cover, true);
        image.alt = '';
        image.loading = 'lazy';
        button.append(image);
      } else {
        const placeholder = document.createElement('span');
        placeholder.className = 'project-placeholder';
        placeholder.setAttribute('aria-hidden', 'true');
        button.append(placeholder);
      }
      const text = document.createElement('span');
      text.className = 'project-item-text';
      const title = document.createElement('strong');
      title.textContent = project.title || 'Проект без названия';
      const detail = document.createElement('small');
      detail.textContent = `${project.published ? 'На сайте' : 'Черновик'} · Фото: ${project.photos.length}${project.loc ? ` · ${project.loc}` : ''}`;
      text.append(title, detail);
      const arrow = document.createElement('span');
      arrow.className = 'project-item-arrow';
      arrow.textContent = '›';
      arrow.setAttribute('aria-hidden', 'true');
      button.append(text, arrow);
      button.addEventListener('click', () => openProject(project));
      list.append(button);
    }
    if (!list.childElementCount) {
      const empty = document.createElement('p');
      empty.className = 'field-hint';
      empty.textContent = 'Пока нет проектов. Добавьте первый.';
      list.append(empty);
    }
  }

  function switchTab(tab) {
    state.tab = tab;
    byId('portfolio-section').hidden = tab !== 'portfolio';
    byId('price-section').hidden = tab !== 'price';
    byId('portfolio-tab').setAttribute('aria-pressed', String(tab === 'portfolio'));
    byId('price-tab').setAttribute('aria-pressed', String(tab === 'price'));
    if (tab === 'portfolio' && state.draft) telegram?.BackButton?.show?.();
    else telegram?.BackButton?.hide?.();
    status('');
  }

  function mayLeaveDraft() {
    return !state.dirty || window.confirm('Есть несохранённые изменения. Перейти без сохранения?');
  }

  function openProject(project) {
    if (!mayLeaveDraft()) return;
    state.draft = structuredClone(project);
    byId('project-list-panel').hidden = true;
    projectForm.hidden = false;
    byId('editor-heading').textContent = project.title || 'Новый проект';
    for (const name of textFields) projectForm.elements.namedItem(name).value = project[name] || '';
    projectForm.elements.namedItem('tags').value = project.tags.join('\n');
    projectForm.elements.namedItem('facts').value = project.facts.map(item => `${item.label} — ${item.value}`).join('\n');
    projectForm.elements.namedItem('published').checked = project.published;
    byId('photo-files').value = '';
    byId('upload-status').textContent = '';
    markDirty(false);
    renderPhotos();
    status('');
    telegram?.BackButton?.show?.();
    projectForm.scrollIntoView({ block: 'start' });
  }

  function backToList() {
    if (state.busy || !mayLeaveDraft()) return;
    state.draft = null;
    markDirty(false);
    projectForm.hidden = true;
    byId('project-list-panel').hidden = false;
    telegram?.BackButton?.hide?.();
    byId('portfolio-heading').scrollIntoView({ block: 'start' });
  }

  function readProject() {
    const project = state.draft;
    for (const name of textFields) project[name] = projectForm.elements.namedItem(name).value.trim();
    project.tags = projectForm.elements.namedItem('tags').value.split('\n').map(value => value.trim()).filter(Boolean);
    project.facts = projectForm.elements.namedItem('facts').value.split('\n').map(value => value.trim()).filter(Boolean).map(line => {
      const separator = line.indexOf(' — ');
      if (separator < 1 || !line.slice(separator + 3).trim()) throw new Error('Характеристики: укажите каждую в виде «название — значение».');
      return { label: line.slice(0, separator).trim(), value: line.slice(separator + 3).trim() };
    });
    project.published = projectForm.elements.namedItem('published').checked;
    if (project.published && (!project.title || !project.photos.length)) {
      throw new Error('Чтобы показать проект на сайте, добавьте название и хотя бы одну фотографию. Или сохраните его как черновик.');
    }
    return project;
  }

  function photoAction(label, handler, options = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = label;
    button.disabled = state.busy || Boolean(options.disabled);
    if (options.aria) button.setAttribute('aria-label', options.aria);
    if (options.pressed !== undefined) button.setAttribute('aria-pressed', String(options.pressed));
    if (options.remove) button.className = 'remove-photo';
    button.addEventListener('click', handler);
    return button;
  }

  function renderPhotos() {
    const list = byId('photo-list');
    list.replaceChildren();
    const photos = state.draft.photos;
    for (const [index, photo] of photos.entries()) {
      const entry = document.createElement('div');
      entry.className = 'photo-entry';
      const image = document.createElement('img');
      image.src = photoUrl(photo.src, true);
      image.alt = photo.alt || `Фото ${index + 1}`;
      image.loading = 'lazy';
      const label = document.createElement('label');
      label.textContent = `Подпись к фото ${index + 1}`;
      const caption = document.createElement('input');
      caption.type = 'text';
      caption.maxLength = 240;
      caption.value = photo.alt;
      caption.disabled = state.busy;
      caption.addEventListener('input', () => { photo.alt = caption.value; markDirty(); });
      label.append(caption);
      const actions = document.createElement('div');
      actions.className = 'photo-actions';
      actions.append(
        photoAction(state.draft.coverPhoto === photo.src ? 'Обложка ✓' : 'Обложка', () => { state.draft.coverPhoto = photo.src; markDirty(); renderPhotos(); }, { pressed: state.draft.coverPhoto === photo.src, aria: `Сделать фото ${index + 1} обложкой` }),
        photoAction('↑', () => { [photos[index - 1], photos[index]] = [photos[index], photos[index - 1]]; markDirty(); renderPhotos(); }, { disabled: index === 0, aria: `Переместить фото ${index + 1} выше` }),
        photoAction('↓', () => { [photos[index + 1], photos[index]] = [photos[index], photos[index + 1]]; markDirty(); renderPhotos(); }, { disabled: index === photos.length - 1, aria: `Переместить фото ${index + 1} ниже` }),
        photoAction('Убрать', () => {
          photos.splice(index, 1);
          if (state.draft.coverPhoto === photo.src) state.draft.coverPhoto = photos[0]?.src || '';
          markDirty();
          renderPhotos();
        }, { remove: true, aria: `Убрать фото ${index + 1} из проекта` })
      );
      entry.append(image, label, actions);
      list.append(entry);
    }
    if (!photos.length) {
      const empty = document.createElement('p');
      empty.className = 'field-hint';
      empty.textContent = 'Фотографий пока нет. Выберите их из галереи телефона или сохраните проект как черновик.';
      list.append(empty);
    }
  }

  async function normalizePhoto(file) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml' || file.size > 50 * 1024 * 1024) {
      throw new Error('Выберите обычную фотографию размером до 50 МБ: JPEG, PNG, WebP или поддерживаемый телефоном формат.');
    }
    const url = URL.createObjectURL(file);
    const image = new Image();
    const canvas = document.createElement('canvas');
    try {
      image.src = url;
      await image.decode();
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 80_000_000) throw new Error('Фотография слишком большая.');
      const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', .86));
      if (!blob || blob.type !== 'image/webp' || blob.size > 8 * 1024 * 1024) throw new Error('Не удалось подготовить фото. Выберите JPEG, PNG или WebP меньшего размера.');
      return blob;
    } catch (error) {
      if (error instanceof Error && /Фотография|Не удалось/.test(error.message)) throw error;
      throw new Error('Телефон не смог открыть эту фотографию. Выберите JPEG, PNG или WebP.');
    } finally {
      URL.revokeObjectURL(url);
      canvas.width = canvas.height = 0;
      image.src = '';
    }
  }

  byId('portfolio-tab').addEventListener('click', () => switchTab('portfolio'));
  byId('price-tab').addEventListener('click', () => switchTab('price'));
  byId('back-to-list').addEventListener('click', backToList);
  telegram?.BackButton?.onClick?.(backToList);
  projectForm.addEventListener('input', event => { if (event.target.type !== 'file') markDirty(); });
  byId('add-project').addEventListener('click', () => openProject({
    id: `project-${crypto.randomUUID()}`, categoryKey: null, title: '', loc: '', desc: '', task: '', work: '',
    tags: [], facts: [], photos: [], coverPhoto: '', published: false
  }));
  byId('reload-content').addEventListener('click', async () => {
    if (state.busy || !mayLeaveDraft()) return;
    setBusy(true);
    try { acceptDocument(await request('/api/admin/content')); status('Данные обновлены.'); }
    catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  });
  byId('price-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy) return;
    const raw = byId('gas-price').value.trim();
    const gasPriceRub = Number(raw.replace(',', '.'));
    if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw) || !Number.isFinite(gasPriceRub) || gasPriceRub <= 0) {
      status('Укажите цену больше нуля, не более двух знаков после запятой.', true);
      return;
    }
    setBusy(true);
    try {
      acceptDocument(await request('/api/admin/price', { method: 'PUT', json: { revision: state.document.revision, gasPriceRub } }));
      status(`Цена сохранена: ${priceFormat.format(gasPriceRub)} ₽/л.`);
    } catch (error) { status(error.message, true); }
    finally { setBusy(false); }
  });
  projectForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (state.busy) return;
    let project;
    try { project = readProject(); }
    catch (error) { status(error.message, true); byId('status').scrollIntoView({ block: 'nearest' }); return; }
    setBusy(true);
    try {
      acceptDocument(await request(`/api/admin/projects/${encodeURIComponent(project.id)}`, { method: 'PUT', json: { revision: state.document.revision, project } }));
      markDirty(false);
      byId('editor-heading').textContent = project.title || 'Проект без названия';
      status(project.published ? 'Проект сохранён. Изменения доступны на сайте.' : 'Черновик сохранён. На сайте он пока не показывается.');
      byId('status').scrollIntoView({ block: 'nearest' });
    } catch (error) { status(error.message, true); byId('status').scrollIntoView({ block: 'nearest' }); }
    finally { setBusy(false); }
  });
  byId('photo-files').addEventListener('change', async event => {
    if (state.busy || !state.draft) return;
    const files = Array.from(event.target.files);
    event.target.value = '';
    if (!files.length) return;
    if (state.draft.photos.length + files.length > 60) { status('В одном проекте может быть до 60 фотографий.', true); return; }
    setBusy(true);
    let uploaded = 0;
    try {
      for (const file of files) {
        byId('upload-status').textContent = `Загружаем фото ${uploaded + 1} из ${files.length}…`;
        const photo = await request('/api/admin/media', { method: 'POST', image: await normalizePhoto(file) });
        photo.alt = projectForm.elements.namedItem('title').value.trim() || file.name.replace(/\.[^.]+$/, '').slice(0, 240);
        state.draft.photos.push(photo);
        if (!state.draft.coverPhoto) state.draft.coverPhoto = photo.src;
        uploaded++;
        markDirty();
        renderPhotos();
      }
      byId('upload-status').textContent = `Загружено: ${uploaded}. Нажмите «Сохранить проект», чтобы показать изменения на сайте.`;
    } catch (error) {
      byId('upload-status').textContent = uploaded ? `Загружено: ${uploaded}. Эти фото остались в форме.` : '';
      status(error.message, true);
    } finally { setBusy(false); }
  });
  window.addEventListener('beforeunload', event => {
    if (state.dirty) { event.preventDefault(); event.returnValue = ''; }
  });

  async function start() {
    telegram?.ready?.();
    telegram?.expand?.();
    if (!initData) {
      byId('access-title').textContent = 'Откройте приложение через бота';
      byId('access-text').textContent = 'Нажмите «Управление сайтом» в Telegram-боте РемГазСервис. В обычном браузере редактирование закрыто.';
      return;
    }
    try {
      acceptDocument(await request('/api/admin/content'));
      byId('access-panel').hidden = true;
      byId('workspace').hidden = false;
    } catch (error) {
      byId('access-title').textContent = 'Не удалось открыть управление';
      byId('access-text').textContent = error.message;
    }
  }
  start();
})();
