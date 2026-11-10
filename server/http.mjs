import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import { isIP } from 'node:net';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { createLeadService } from './lead.mjs';
import { loadConfig } from './config.mjs';
import { createContentService } from './content.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const pages = new Set(['index.html', 'gas.html', 'portfolio.html', 'admin/index.html']);
const mime = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.avif': 'image/avif', '.gif': 'image/gif',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2'
};
const policy = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' mailto:; frame-ancestors 'none'";
const security = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': policy
};
const adminSecurity = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
};

function clientIp(req, trustProxy) {
  const remote = req.socket.remoteAddress || '';
  const peer = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
  if (trustProxy && (peer === '127.0.0.1' || peer === '::1')) {
    const header = req.headers['x-real-ip'];
    if (typeof header !== 'string' || !isIP(header)) return '';
    return header.startsWith('::ffff:') ? header.slice(7) : header;
  }
  return peer;
}

function pathnameOf(rawUrl) {
  const raw = rawUrl.split(/[?#]/, 1)[0];
  if (!raw.startsWith('/') || raw.includes('\\') || /%(?:2f|5c|00)/i.test(raw)) return null;
  let decoded;
  try { decoded = decodeURIComponent(raw); } catch { return null; }
  if (decoded.split('/').some(segment => segment === '.' || segment === '..' || segment.startsWith('.'))) return null;
  return decoded;
}

function staticName(pathname) {
  if (pathname === '/') return 'index.html';
  if (pathname === '/admin/') return 'admin/index.html';
  const name = pathname.slice(1);
  if (pages.has(name)) return name;
  if (!/^assets\/[a-f0-9]{16}\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(name)) return null;
  return mime[extname(name).toLowerCase()] ? name : null;
}

function sendJson(res, status, body, extra = {}) {
  res.writeHead(status, { ...security, 'Cache-Control': 'no-store', 'Content-Type': 'application/json; charset=utf-8', ...extra });
  res.end(JSON.stringify(body));
}

function webRequest(req, url) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined) headers.set(name, Array.isArray(value) ? value.join(', ') : value);
  }
  const hasBody = !['GET', 'HEAD', 'OPTIONS'].includes(req.method);
  return new Request(url, {
    method: req.method, headers,
    ...(hasBody ? { body: Readable.toWeb(req), duplex: 'half' } : {})
  });
}

async function writeResponse(res, response) {
  res.writeHead(response.status, {
    ...security, 'Cache-Control': 'no-store', ...Object.fromEntries(response.headers),
    ...(response.status === 413 ? { Connection: 'close' } : {})
  });
  if (response.body) await pipeline(Readable.fromWeb(response.body), res);
  else res.end();
}

export function createHttpServer(config, service = createLeadService(config), distRoot = root) {
  let contentService;
  try { contentService = config.contentDbPath ? createContentService(config) : null; }
  catch (error) { service.close(); throw error; }
  const server = createServer({ maxHeaderSize: 16 * 1024 }, async (req, res) => {
    try {
      const path = pathnameOf(req.url || '');
      if (path === null) { sendJson(res, 400, { ok: false, error: 'Invalid path' }); return; }
      if (path === '/healthz') {
        if (req.method !== 'GET') { sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET' }); return; }
        sendJson(res, 200, { ok: true });
        return;
      }
      if (path === '/admin') {
        res.writeHead(308, { ...security, Location: '/admin/', 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      if (path === '/api/content' || path === '/content/site.json' || path.startsWith('/api/admin/') || path.startsWith('/media/')) {
        if (!contentService) { sendJson(res, 404, { ok: false, error: 'Not found' }); return; }
        const contentPath = path === '/content/site.json' ? '/api/content' : path;
        await writeResponse(res, await contentService.handle(webRequest(req, `${config.origin}${contentPath}`)));
        return;
      }
      if (path === '/api/lead') {
        if (req.method !== 'POST' && req.method !== 'OPTIONS') {
          sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'POST, OPTIONS' });
          return;
        }
        if (req.method === 'POST' && Number(req.headers['content-length']) > 4_096) {
          sendJson(res, 413, { ok: false, error: 'Request too large' }, { Connection: 'close' });
          return;
        }
        await writeResponse(res, await service.handle(webRequest(req, `${config.origin}/api/lead`), clientIp(req, config.trustProxy)));
        return;
      }
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJson(res, 405, { ok: false, error: 'Method not allowed' }, { Allow: 'GET, HEAD' });
        return;
      }
      const name = staticName(path);
      if (!name) { sendJson(res, 404, { ok: false, error: 'Not found' }); return; }
      const target = join(distRoot, name);
      const actualRoot = await realpath(distRoot);
      const actual = await realpath(target).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!actual || relative(actualRoot, actual).startsWith(`..${sep}`) || actual === actualRoot) {
        sendJson(res, 404, { ok: false, error: 'Not found' }); return;
      }
      const info = await lstat(actual);
      if (!info.isFile()) { sendJson(res, 404, { ok: false, error: 'Not found' }); return; }
      const etag = `W/"${info.ino.toString(16)}-${info.size.toString(16)}-${Math.floor(info.mtimeMs).toString(16)}"`;
      const immutable = name.startsWith('assets/');
      const headers = {
        ...(name === 'admin/index.html' ? adminSecurity : security),
        'Content-Type': mime[extname(name).toLowerCase()],
        'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
        ETag: etag
      };
      if (req.headers['if-none-match']?.split(',').some(value => value.trim() === etag || value.trim() === '*')) {
        res.writeHead(304, headers); res.end(); return;
      }
      res.writeHead(200, { ...headers, 'Content-Length': info.size });
      if (req.method === 'HEAD') { res.end(); return; }
      createReadStream(actual).on('error', () => res.destroy()).pipe(res);
    } catch (error) {
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'Server error' });
      else res.destroy();
      console.error('Request failed:', error?.message || 'unknown error');
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.timeout = 30_000;
  server.on('close', () => { service.close(); contentService?.close(); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = loadConfig();
    const server = createHttpServer(config);
    server.listen(config.port, config.host, () => console.log(`Listening on ${config.host}:${config.port}`));
    const shutdown = () => {
      server.close();
      server.closeIdleConnections();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
