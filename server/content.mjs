import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync, closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readFileSync, realpathSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TelegramAuthError, verifyTelegramInitData } from './telegram-admin.mjs';

const MAX_JSON = 64 * 1024;
const MAX_MEDIA = 8 * 1024 * 1024;
const MAX_IMAGE_SIDE = 2400;
const MAX_IMAGE_PIXELS = 2400 * 2400;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const BUNDLED_PHOTO = /^assets\/portfolio\/[a-zA-Z0-9][a-zA-Z0-9_-]*\.webp$/;
const MEDIA_PHOTO = /^\/media\/([a-f0-9]{64}\.webp)$/;
const CATEGORIES = new Set(['house', 'hotel', 'spa', 'production', 'seasonal', 'restaurant', 'agro']);
const PROJECT_FIELDS = ['id', 'categoryKey', 'title', 'loc', 'desc', 'task', 'work', 'tags', 'facts', 'photos', 'coverPhoto', 'published'];
const OPTIONAL_TEXT = { cardDesc: 2000, navTitle: 200, categorySummary: 240 };

class ContentError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalid(message = 'Некорректные данные.') {
  throw new ContentError(400, message);
}

function record(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      required.some(key => !Object.hasOwn(value, key)) ||
      Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) invalid();
}

function text(value, maximum, required = false) {
  if (typeof value !== 'string' || value.length > maximum || (required && !value.trim()) ||
      /[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(value)) {
    invalid('Используйте обычный текст без HTML в пределах допустимой длины.');
  }
}

function revision(value) {
  if (!Number.isSafeInteger(value) || value < 1) invalid('Некорректная версия данных.');
}

function price(value) {
  const cents = typeof value === 'number' ? Math.round(value * 100) : NaN;
  if (typeof value !== 'number' || !Number.isSafeInteger(cents) || cents <= 0 || cents / 100 !== value) {
    invalid('Укажите положительную цену с точностью до копейки.');
  }
}

function validateProject(project, media) {
  record(project, PROJECT_FIELDS, Object.keys(OPTIONAL_TEXT));
  if (typeof project.id !== 'string' || !SLUG.test(project.id) ||
      (project.categoryKey !== null && !CATEGORIES.has(project.categoryKey)) ||
      typeof project.published !== 'boolean') invalid();
  text(project.title, 200, project.published);
  text(project.loc, 240);
  text(project.desc, 2000);
  text(project.task, 8000);
  text(project.work, 12000);
  for (const [key, maximum] of Object.entries(OPTIONAL_TEXT)) {
    if (Object.hasOwn(project, key)) text(project[key], maximum);
  }
  if (!Array.isArray(project.tags) || project.tags.length > 12) invalid();
  for (const tag of project.tags) text(tag, 160);
  if (!Array.isArray(project.facts) || project.facts.length > 16) invalid();
  for (const fact of project.facts) {
    record(fact, ['label', 'value']);
    text(fact.label, 120);
    text(fact.value, 240);
  }
  if (!Array.isArray(project.photos) || project.photos.length > 60 ||
      (project.published && project.photos.length === 0)) invalid('Опубликованному проекту нужно хотя бы одно фото.');
  for (const photo of project.photos) {
    record(photo, ['src', 'alt', 'width', 'height']);
    text(photo.alt, 240);
    if (typeof photo.src !== 'string' || !Number.isSafeInteger(photo.width) || !Number.isSafeInteger(photo.height) ||
        photo.width < 1 || photo.height < 1 || photo.width > 16384 || photo.height > 16384 ||
        photo.width * photo.height > 64_000_000) invalid('Некорректные размеры фотографии.');
    const uploaded = MEDIA_PHOTO.exec(photo.src);
    if (uploaded) {
      const stored = media(uploaded[1]);
      if (!stored || photo.width !== stored.width || photo.height !== stored.height) invalid('Фотография не загружена на сервер или её размеры изменены.');
    } else if (!BUNDLED_PHOTO.test(photo.src)) {
      invalid('Недопустимый путь к фотографии.');
    }
  }
  if (typeof project.coverPhoto !== 'string' || (project.photos.length === 0
    ? project.coverPhoto !== ''
    : !project.photos.some(photo => photo.src === project.coverPhoto))) invalid('Выберите обложку из фотографий проекта.');
}

function validateDocument(document, media) {
  record(document, ['revision', 'gasPriceRub', 'projects']);
  revision(document.revision);
  price(document.gasPriceRub);
  if (!Array.isArray(document.projects)) invalid();
  const ids = new Set();
  const categories = new Set();
  for (const project of document.projects) {
    validateProject(project, media);
    if (ids.has(project.id) || (project.categoryKey !== null && categories.has(project.categoryKey))) invalid();
    ids.add(project.id);
    if (project.categoryKey !== null) categories.add(project.categoryKey);
  }
}

function json(value, status = 200, headers = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  });
}

async function readLimitedBody(request, maximum) {
  const declared = request.headers.get('content-length');
  if (declared !== null && (!/^\d+$/.test(declared) || !Number.isSafeInteger(Number(declared)))) invalid('Некорректный размер запроса.');
  if (declared !== null && Number(declared) > maximum) throw new ContentError(413, 'Слишком большой файл или запрос.');
  const reader = request.body?.getReader();
  if (!reader) invalid('Пустой запрос.');
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) invalid();
      size += value.byteLength;
      if (size > maximum) {
        void reader.cancel().catch(() => {});
        throw new ContentError(413, 'Слишком большой файл или запрос.');
      }
      if (value.byteLength) chunks.push(value);
    }
    if (declared !== null && size !== Number(declared)) invalid('Размер запроса не совпадает с заголовком.');
    return Buffer.concat(chunks, size);
  } catch (error) {
    if (error instanceof ContentError) throw error;
    invalid('Не удалось прочитать запрос.');
  } finally {
    reader.releaseLock();
  }
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) {
    throw new ContentError(415, 'Ожидается JSON.');
  }
  const bytes = await readLimitedBody(request, MAX_JSON);
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    invalid('Некорректный JSON.');
  }
}

function imageSize(width, height) {
  if (width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS) invalid('Фотография должна быть не больше 2400 пикселей по каждой стороне.');
  return { width, height };
}

// Validate the RIFF structure and image headers, not the compressed pixel stream.
// Canvas normalizes uploads; only a single, non-animated WebP image is accepted.
function webpSize(bytes) {
  const bad = () => invalid('Некорректный или анимированный WebP.');
  if (bytes.length < 26 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) !== bytes.length - 8) bad();
  let extended = null;
  let image = null;
  let alpha = false;
  let losslessAlpha = false;
  const seen = new Set();
  for (let offset = 12; offset < bytes.length;) {
    if (offset + 8 > bytes.length) bad();
    const kind = bytes.toString('latin1', offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + length;
    const next = end + (length & 1);
    if (next > bytes.length || (length & 1 && bytes[end] !== 0) || seen.has(kind)) bad();
    seen.add(kind);
    if (kind === 'VP8X') {
      if (offset !== 12 || length !== 10) bad();
      const flags = bytes[start];
      if (flags & 0xc3 || bytes.readUIntLE(start + 1, 3) !== 0) bad();
      extended = { flags, ...imageSize(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1) };
    } else if (kind === 'VP8 ') {
      if (image || length <= 10) bad();
      const frame = bytes.readUIntLE(start, 3);
      const partition = frame >>> 5;
      if ((frame & 1) !== 0 || ((frame >>> 1) & 7) > 3 || (frame & 16) === 0 ||
          partition < 1 || partition > length - 10 ||
          bytes[start + 3] !== 0x9d || bytes[start + 4] !== 1 || bytes[start + 5] !== 0x2a) bad();
      const width = bytes.readUInt16LE(start + 6);
      const height = bytes.readUInt16LE(start + 8);
      if (width & 0xc000 || height & 0xc000) bad();
      image = imageSize(width, height);
    } else if (kind === 'VP8L') {
      if (image || alpha || length <= 5 || bytes[start] !== 0x2f) bad();
      const bits = bytes.readUInt32LE(start + 1);
      if (bits >>> 29) bad();
      losslessAlpha = Boolean(bits & 0x10000000);
      image = imageSize((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
    } else if (kind === 'ALPH') {
      if (!extended || image || !(extended.flags & 16) || length < 2) bad();
      const flags = bytes[start];
      if ((flags & 0xc0) !== 0 || ((flags >>> 4) & 3) > 1 || (flags & 3) > 1 ||
          ((flags & 3) === 0 && length !== 1 + extended.width * extended.height)) bad();
      alpha = true;
    } else if (kind === 'ICCP' || kind === 'EXIF' || kind === 'XMP ') {
      const flag = { ICCP: 32, EXIF: 8, 'XMP ': 4 }[kind];
      if (!extended || !(extended.flags & flag) || length === 0 || (kind === 'ICCP' && (image || alpha))) bad();
    } else {
      // ANIM/ANMF and unknown chunks are not emitted by the photo editor.
      bad();
    }
    offset = next;
  }
  if (!image || (!extended && seen.size !== 1)) bad();
  if (extended) {
    if (image.width !== extended.width || image.height !== extended.height ||
        Boolean(extended.flags & 32) !== seen.has('ICCP') ||
        Boolean(extended.flags & 8) !== seen.has('EXIF') ||
        Boolean(extended.flags & 4) !== seen.has('XMP ') ||
        Boolean(extended.flags & 16) !== (alpha || losslessAlpha)) bad();
  }
  return image;
}

export function createContentService(config, { seedPath = new URL('../content/site.json', import.meta.url) } = {}) {
  const { origin, telegramBotToken, contentDbPath, contentMediaDir } = config;
  let configuredOrigin;
  try { configuredOrigin = new URL(origin); } catch { throw new Error('Invalid content service configuration'); }
  if (!['http:', 'https:'].includes(configuredOrigin.protocol) || configuredOrigin.origin !== origin ||
      typeof telegramBotToken !== 'string' || !telegramBotToken ||
      typeof contentDbPath !== 'string' || !contentDbPath || typeof contentMediaDir !== 'string' || !contentMediaDir) {
    throw new Error('Invalid content service configuration');
  }
  const configuredMediaRoot = resolve(contentMediaDir);
  if (dirname(configuredMediaRoot) === configuredMediaRoot) throw new Error('Media root must be a dedicated directory');
  mkdirSync(configuredMediaRoot, { recursive: true, mode: 0o700 });
  if (!lstatSync(configuredMediaRoot).isDirectory()) throw new Error('Media root must be a real directory');
  const mediaRoot = realpathSync(configuredMediaRoot);
  const rootInfo = lstatSync(mediaRoot);
  chmodSync(mediaRoot, 0o700);
  mkdirSync(dirname(contentDbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(contentDbPath);
  const transaction = work => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      db.exec('COMMIT');
      return value;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  let q;
  try {
    chmodSync(contentDbPath, 0o600);
    db.exec('PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
    transaction(() => {
      const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();
      if (tables.length === 0) {
        const seed = JSON.parse(readFileSync(seedPath, 'utf8'));
        validateDocument(seed, () => null);
        db.exec(`CREATE TABLE content_document (
          id INTEGER PRIMARY KEY CHECK (id=1), revision INTEGER NOT NULL CHECK (revision>=1),
          document TEXT NOT NULL CHECK (json_valid(document))
        );
        CREATE TABLE content_media (
          filename TEXT PRIMARY KEY, width INTEGER NOT NULL CHECK (width>0),
          height INTEGER NOT NULL CHECK (height>0), bytes INTEGER NOT NULL CHECK (bytes>0)
        );`);
        db.prepare('INSERT INTO content_document(id,revision,document) VALUES (1,?,?)').run(seed.revision, JSON.stringify(seed));
      } else if (!tables.some(table => table.name === 'content_document') || !tables.some(table => table.name === 'content_media')) {
        throw new Error('Content database is not empty and has an unexpected schema');
      }
      q = {
        document: db.prepare('SELECT revision,document FROM content_document WHERE id=1'),
        update: db.prepare('UPDATE content_document SET revision=?,document=? WHERE id=1 AND revision=?'),
        media: db.prepare('SELECT width,height,bytes FROM content_media WHERE filename=?'),
        insertMedia: db.prepare('INSERT INTO content_media(filename,width,height,bytes) VALUES (?,?,?,?) ON CONFLICT(filename) DO NOTHING'),
      };
      const saved = q.document.get();
      if (!saved) throw new Error('Content database has no document; refusing to reseed');
      const document = JSON.parse(saved.document);
      validateDocument(document, filename => q.media.get(filename));
      if (saved.revision !== document.revision) throw new Error('Content database revision mismatch');
    });
  } catch (error) {
    db.close();
    throw error;
  }

  function assertMediaRoot() {
    const current = lstatSync(mediaRoot);
    if (!current.isDirectory() || current.dev !== rootInfo.dev || current.ino !== rootInfo.ino ||
        realpathSync(configuredMediaRoot) !== mediaRoot) throw new Error('Media root changed');
  }

  function readMedia(filename, stored, head = false) {
    assertMediaRoot();
    const fd = openSync(join(mediaRoot, filename), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size !== stored.bytes || stat.size > MAX_MEDIA) throw new Error('Invalid media file');
      if (head) return null;
      const bytes = readFileSync(fd);
      if (createHash('sha256').update(bytes).digest('hex') !== filename.slice(0, 64)) throw new Error('Media hash mismatch');
      return bytes;
    } finally {
      closeSync(fd);
    }
  }

  function storeMedia(bytes, dimensions) {
    assertMediaRoot();
    const filename = `${createHash('sha256').update(bytes).digest('hex')}.webp`;
    const target = join(mediaRoot, filename);
    const stored = { ...dimensions, bytes: bytes.length };
    const temporary = join(mediaRoot, `.upload-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temporary, target);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // A crash after link may leave a private temp hardlink; verify the bytes, not the link count.
        readMedia(filename, stored);
      }
    } finally {
      // An interrupted write can leave only an unregistered temp, never a partial hash filename.
      unlinkSync(temporary);
    }
    // Persist the published name and temp removal before SQLite can commit the registry row.
    const directoryFd = openSync(mediaRoot, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
      fsyncSync(directoryFd);
    } finally {
      closeSync(directoryFd);
    }
    q.insertMedia.run(filename, dimensions.width, dimensions.height, bytes.length);
    const registered = q.media.get(filename);
    if (registered.width !== dimensions.width || registered.height !== dimensions.height || registered.bytes !== bytes.length) {
      throw new Error('Media registry mismatch');
    }
    return { src: `/media/${filename}`, alt: '', ...dimensions };
  }

  function authenticate(request, write) {
    const authorization = request.headers.get('authorization') || '';
    const match = /^tma (.+)$/i.exec(authorization);
    if (!match) throw new TelegramAuthError();
    verifyTelegramInitData(match[1], telegramBotToken);
    if (write && request.headers.get('origin') !== origin) throw new ContentError(403, 'Изменения разрешены только из приложения на нашем сайте.');
  }

  function change(expectedRevision, update) {
    revision(expectedRevision);
    return transaction(() => {
      const saved = q.document.get();
      if (saved.revision !== expectedRevision) throw new ContentError(409, 'Данные уже изменились. Обновите их перед сохранением.');
      if (saved.revision === Number.MAX_SAFE_INTEGER) throw new ContentError(409, 'Достигнут предел версии данных.');
      const document = JSON.parse(saved.document);
      update(document);
      document.revision += 1;
      const result = q.update.run(document.revision, JSON.stringify(document), expectedRevision);
      if (result.changes !== 1) throw new ContentError(409, 'Данные уже изменились. Обновите их перед сохранением.');
      return document;
    });
  }

  async function handle(request) {
    try {
      const path = new URL(request.url).pathname;
      const method = request.method;
      const mediaMatch = MEDIA_PHOTO.exec(path);
      if (mediaMatch) {
        if (method !== 'GET' && method !== 'HEAD') return json({ ok: false, error: 'Метод не поддерживается.' }, 405, { Allow: 'GET, HEAD' });
        const stored = q.media.get(mediaMatch[1]);
        if (!stored) return json({ ok: false, error: 'Фотография не найдена.' }, 404);
        let bytes;
        try { bytes = readMedia(mediaMatch[1], stored, method === 'HEAD'); }
        catch { return json({ ok: false, error: 'Фотография не найдена.' }, 404); }
        const etag = `"${mediaMatch[1].slice(0, 64)}"`;
        const headers = {
          'Content-Type': 'image/webp', 'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'public, max-age=31536000, immutable',
          'Access-Control-Allow-Origin': '*', ETag: etag,
        };
        if (request.headers.get('if-none-match')?.split(',').some(value => value.trim().replace(/^W\//, '') === etag || value.trim() === '*')) {
          return new Response(null, { status: 304, headers });
        }
        return new Response(bytes, { headers: { ...headers, 'Content-Length': String(stored.bytes) } });
      }
      const projectMatch = /^\/api\/admin\/projects\/([a-z0-9]+(?:-[a-z0-9]+)*)$/.exec(path);
      const expectedMethod = path === '/api/content' || path === '/api/admin/content' ? 'GET'
        : path === '/api/admin/price' || projectMatch ? 'PUT'
          : path === '/api/admin/media' ? 'POST' : null;
      if (!expectedMethod) return json({ ok: false, error: 'Не найдено.' }, 404);
      if (method !== expectedMethod) return json({ ok: false, error: 'Метод не поддерживается.' }, 405, { Allow: expectedMethod });
      if (path === '/api/content') {
        const document = JSON.parse(q.document.get().document);
        document.projects = document.projects.filter(project => project.published);
        return json(document, 200, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-cache' });
      }
      authenticate(request, method !== 'GET');
      if (path === '/api/admin/content') return json(JSON.parse(q.document.get().document));
      if (path === '/api/admin/media') {
        if ((request.headers.get('content-type') || '').toLowerCase() !== 'image/webp') throw new ContentError(415, 'Загружайте фотографии в формате WebP.');
        const bytes = await readLimitedBody(request, MAX_MEDIA);
        return json(storeMedia(bytes, webpSize(bytes)));
      }
      const body = await readJson(request);
      if (path === '/api/admin/price') {
        record(body, ['revision', 'gasPriceRub']);
        price(body.gasPriceRub);
        return json(change(body.revision, document => { document.gasPriceRub = body.gasPriceRub; }));
      }
      record(body, ['revision', 'project']);
      validateProject(body.project, filename => q.media.get(filename));
      if (body.project.id !== projectMatch[1]) invalid('Идентификатор проекта не совпадает с адресом.');
      return json(change(body.revision, document => {
        const index = document.projects.findIndex(project => project.id === body.project.id);
        if (index === -1) {
          if (body.project.categoryKey !== null) invalid('Новый проект не может изменять существующие категории.');
          document.projects.push(body.project);
        } else {
          if (body.project.categoryKey !== document.projects[index].categoryKey) invalid('Категорию существующего проекта менять нельзя.');
          document.projects[index] = body.project;
        }
      }));
    } catch (error) {
      if (error instanceof ContentError || error instanceof TelegramAuthError) return json({ ok: false, error: error.message }, error.status);
      return json({ ok: false, error: 'Не удалось сохранить или прочитать данные на сервере.' }, 500);
    }
  }

  let closed = false;
  return {
    handle,
    close() {
      if (!closed) { db.close(); closed = true; }
    },
  };
}
