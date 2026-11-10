import { isAbsolute } from 'node:path';
const origin = process.env.PUBLIC_ORIGIN;
if (!origin) throw new Error('PUBLIC_ORIGIN is required');
const url = new URL(origin);
if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin || url.username || url.password) {
  throw new Error('PUBLIC_ORIGIN must be a bare http(s) origin');
}
const tls = url.protocol === 'https:';
const hostAddress = process.env.HOST || '127.0.0.1';
if (!['127.0.0.1', '::1'].includes(hostAddress)) throw new Error('HOST must be loopback');
const backendPort = process.env.PORT || '8080';
if (!/^\d+$/.test(backendPort) || Number(backendPort) < 1 || Number(backendPort) > 65535) {
  throw new Error('PORT must be between 1 and 65535');
}
const pathname = (name, fallback) => {
  const value = process.env[name] || fallback;
  if (!isAbsolute(value) || !/^\/[\w./-]+$/.test(value) || value.includes('/../') || value.endsWith('/..')) {
    throw new Error(`${name} must be a safe absolute path`);
  }
  return value.replace(/\/$/, '');
};
const release = pathname('RELEASE_DIST', '/opt/remgaz/current/dist');
const shared = pathname('SHARED_ASSETS', '/opt/remgaz/shared/assets');
if (!shared.endsWith('/assets')) throw new Error('SHARED_ASSETS must end in /assets');
const quote = value => {
  if (!/^[a-zA-Z0-9.:-]+$/.test(value)) throw new Error('Invalid server name');
  return value;
};
const cert = tls ? pathname('TLS_CERT_FILE', '') : null;
const key = tls ? pathname('TLS_KEY_FILE', '') : null;
const headers = `    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "strict-origin-when-cross-origin" always;
    add_header X-Frame-Options "DENY" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self' mailto:; frame-ancestors 'none'" always;${tls ? '\n    add_header Strict-Transport-Security "max-age=31536000" always;' : ''}`;
const adminHeaders = `    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Content-Security-Policy "default-src 'self'; script-src 'self' https://telegram.org; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' https://web.telegram.org https://*.telegram.org" always;${tls ? '\n    add_header Strict-Transport-Security "max-age=31536000" always;' : ''}`;
const upstream = `http://${hostAddress === '::1' ? '[::1]' : hostAddress}:${backendPort}`;
const port = url.port || (tls ? '443' : '80');
const host = quote(url.hostname);
const listen = tls ? `listen ${port} ssl;\n  ssl_certificate ${cert};\n  ssl_certificate_key ${key};` : `listen ${port};`;
const site = `# Generated from PUBLIC_ORIGIN. Install within nginx http {}, never publish server.env.
# Never run build in active current: prepare an inactive release instead.
# Run assets:install for its dist before atomically switching current; keep every older asset tag.
# The operator restarts the API only after switching current to the new release.
# Assets are served from ${shared}, independent of the currently selected HTML release.
limit_req_zone $binary_remote_addr zone=remgaz_lead:10m rate=5r/m;
limit_req_zone $binary_remote_addr zone=remgaz_admin:10m rate=120r/m;
server {
  ${listen}
  server_name ${host};
  root ${release};
  disable_symlinks on from=$document_root;
  gzip on;
  gzip_vary on;
  gzip_min_length 1024;
  gzip_types text/css text/javascript application/javascript application/json image/svg+xml;
  client_max_body_size 16k;
${headers}

  location = / {
    try_files /index.html =404;
    add_header Cache-Control "no-cache" always;
${headers}
  }
  location ~ ^/(?:index|gas|portfolio)\\.html$ {
    try_files $uri =404;
    add_header Cache-Control "no-cache" always;
${headers}
  }
  location = /content/site.json {
    limit_except GET OPTIONS { deny all; }
    proxy_set_header Host $host;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_pass ${upstream}/api/content;
${headers}
  }
  location = /admin {
    return 308 /admin/;
${adminHeaders}
  }
  location ~ ^/admin/(?:index\\.html)?$ {
    try_files /admin/index.html =404;
    add_header Cache-Control "no-store" always;
${adminHeaders}
  }
  location = /api/content {
    limit_except GET OPTIONS { deny all; }
    proxy_set_header Host $host;
    proxy_connect_timeout 3s;
    proxy_read_timeout 15s;
    proxy_pass ${upstream};
${headers}
  }
  location ^~ /api/admin/ {
    limit_req zone=remgaz_admin burst=30 nodelay;
    limit_req_status 429;
    client_max_body_size 8m;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_connect_timeout 3s;
    proxy_send_timeout 30s;
    proxy_read_timeout 30s;
    proxy_pass ${upstream};
${headers}
  }
  location ~ "^/media/[a-f0-9]{64}\\.webp$" {
    proxy_set_header Host $host;
    proxy_connect_timeout 3s;
    proxy_read_timeout 30s;
    proxy_pass ${upstream};
${headers}
  }
  location ~ "^/assets/[a-f0-9]{16}/(?:[A-Za-z0-9_-]+/)*[A-Za-z0-9_-]+\\.(?:css|js|webp|avif|png|jpe?g|svg|gif|ico|woff2?)$" {
    root ${shared.slice(0, -'/assets'.length)};
    try_files $uri =404;
    add_header Cache-Control "public, max-age=31536000, immutable";
${headers}
  }
  location = /healthz {
    proxy_pass http://${hostAddress === '::1' ? '[::1]' : hostAddress}:${backendPort};
    proxy_connect_timeout 3s;
    proxy_read_timeout 5s;
${headers}
  }
  location = /api/lead {
    limit_except POST OPTIONS { deny all; }
    limit_req zone=remgaz_lead burst=5 nodelay;
    limit_req_status 429;
    client_max_body_size 16k;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header CF-Connecting-IP "";
    proxy_connect_timeout 3s;
    proxy_send_timeout 15s;
    proxy_read_timeout 30s;
    proxy_pass http://${hostAddress === '::1' ? '[::1]' : hostAddress}:${backendPort};
${headers}
  }
  location / {
    return 404;
${headers}
  }
}
`;
if (process.argv.includes('--standalone')) {
  process.stdout.write(`pid /tmp/remgaz-nginx.pid;\nerror_log stderr;\nevents {}\nhttp {\n  types { text/html html; text/css css; application/javascript js; application/json json; image/webp webp; image/jpeg jpeg jpg; image/png png; image/svg+xml svg; font/woff2 woff2; }\n${site}}\n`);
} else process.stdout.write(site);
