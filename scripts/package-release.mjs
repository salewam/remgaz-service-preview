import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const artifacts = join(root, 'artifacts');
const pages = ['index.html', 'gas.html', 'portfolio.html', 'admin/index.html'];
const publicExtension = /\.(?:css|js|webp|avif|png|jpe?g|svg|gif|ico|woff2?)$/i;
const runtime = [
  'server/http.mjs', 'server/lead.mjs', 'server/config.mjs',
  'server/content.mjs', 'server/telegram-admin.mjs', 'content/site.json',
  'scripts/configure-admin-bot.mjs',
  'deploy/install-assets.mjs', 'deploy/nginx.mjs', 'deploy/remgaz.service'
];
const fontLicenses = [
  'manrope-OFL.txt', 'plus-jakarta-sans-OFL.txt', 'jetbrains-mono-OFL.txt'
];
const envNames = new Set([
  'PUBLIC_ORIGIN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LEAD_IP_HASH_SECRET',
  'LEAD_DB_PATH', 'HOST', 'PORT', 'TRUST_PROXY', 'TURNSTILE_SECRET',
  'CONTENT_DB_PATH', 'CONTENT_MEDIA_DIR'
]);
const safeEnvDefaults = new Map([
  ['LEAD_DB_PATH', '/var/lib/remgaz/leads.sqlite'],
  ['CONTENT_DB_PATH', '/var/lib/remgaz/content.sqlite'],
  ['CONTENT_MEDIA_DIR', '/var/lib/remgaz/media'],
  ['HOST', '127.0.0.1'],
  ['PORT', '8080'],
  ['TRUST_PROXY', 'true']
]);

async function regularFile(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Not a regular file: ${relative(root, path)}`);
}

async function copyRegular(source, destination) {
  await regularFile(source);
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  await regularFile(destination);
}

async function copyAssets(source, destination) {
  const entries = await readdir(source, { withFileTypes: true });
  if (!entries.length) throw new Error(`Empty asset directory: ${relative(root, source)}`);
  for (const entry of entries) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory() && /^[a-zA-Z0-9_-]+$/.test(entry.name)) {
      const stat = await lstat(from);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`Unsafe asset directory: ${from}`);
      await copyAssets(from, to);
    } else if (entry.isFile() && /^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$/.test(entry.name) && publicExtension.test(entry.name)) {
      await copyRegular(from, to);
    } else throw new Error(`Non-public asset: ${relative(root, from)}`);
  }
}

async function copyDist(payload) {
  const stat = await lstat(dist);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist must be a regular directory; run npm run build');
  const top = (await readdir(dist)).sort();
  if (JSON.stringify(top) !== JSON.stringify([...new Set(pages.map(page => page.split('/')[0])), 'content', 'assets'].sort())) {
    throw new Error('dist must contain only public HTML pages, admin and assets');
  }
  const admin = await lstat(join(dist, 'admin'));
  if (!admin.isDirectory() || admin.isSymbolicLink() || JSON.stringify(await readdir(join(dist, 'admin'))) !== '["index.html"]') {
    throw new Error('dist/admin must contain only index.html');
  }
  const content = await lstat(join(dist, 'content'));
  if (!content.isDirectory() || content.isSymbolicLink() || JSON.stringify(await readdir(join(dist, 'content'))) !== '["site.json"]') {
    throw new Error('dist/content must contain only site.json');
  }
  await copyRegular(join(dist, 'content/site.json'), join(payload, 'dist/content/site.json'));
  const versionRoot = join(dist, 'assets');
  const assetsStat = await lstat(versionRoot);
  if (!assetsStat.isDirectory() || assetsStat.isSymbolicLink()) throw new Error('dist/assets must be a regular directory');
  const versions = await readdir(versionRoot);
  if (versions.length !== 1 || !/^[a-f0-9]{16}$/.test(versions[0])) {
    throw new Error('dist must contain exactly one versioned assets directory');
  }
  const tag = versions[0];
  const version = join(versionRoot, tag);
  const versionStat = await lstat(version);
  if (!versionStat.isDirectory() || versionStat.isSymbolicLink()) throw new Error('Versioned assets must be a regular directory');
  for (const page of pages) {
    const source = join(dist, page);
    await regularFile(source);
    const html = await readFile(source, 'utf8');
    if (!html.includes(`assets/${tag}/`)) throw new Error(`${page} does not reference current assets`);
    await copyRegular(source, join(payload, 'dist', page));
  }
  await copyAssets(version, join(payload, 'dist', 'assets', tag));
  return tag;
}

async function copyEnvironmentExample(payload) {
  const source = join(root, 'deploy/server.env.example');
  await regularFile(source);
  const seen = new Set();
  const example = (await readFile(source, 'utf8')).split('\n').map(line => {
    if (!line || line.startsWith('#')) return line;
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!match || !envNames.has(match[1]) || seen.has(match[1])) throw new Error('Invalid server.env.example');
    seen.add(match[1]);
    const defaultValue = safeEnvDefaults.get(match[1]);
    if (defaultValue !== undefined && match[2] !== defaultValue) throw new Error(`Unexpected default in server.env.example: ${match[1]}`);
    return `${match[1]}=${defaultValue ?? ''}`;
  }).join('\n');
  if (seen.size !== envNames.size) throw new Error('Missing settings in server.env.example');
  await writeFile(join(payload, 'deploy/server.env.example'), example);
}

async function contentHash(directory) {
  const hash = createHash('sha256');
  async function visit(path, prefix = '') {
    for (const name of (await readdir(path)).sort()) {
      const filename = join(path, name);
      const entry = await lstat(filename);
      const label = prefix ? `${prefix}/${name}` : name;
      if (entry.isDirectory() && !entry.isSymbolicLink()) await visit(filename, label);
      else if (entry.isFile() && !entry.isSymbolicLink()) {
        hash.update(`${label}\0${entry.size}\0`);
        for await (const chunk of createReadStream(filename)) hash.update(chunk);
      } else throw new Error(`Non-regular release entry: ${label}`);
    }
  }
  await visit(directory);
  return hash.digest('hex');
}

async function packageRelease() {
  await mkdir(artifacts, { recursive: true });
  const outputDir = await lstat(artifacts);
  if (!outputDir.isDirectory() || outputDir.isSymbolicLink()) throw new Error('artifacts must be a regular directory');
  const stage = await mkdtemp(join(artifacts, '.remgaz-release-'));
  let linkedArchive;
  let linkedChecksum = false;
  try {
    const payload = join(stage, 'payload');
    await mkdir(payload);
    const tag = await copyDist(payload);
    for (const name of runtime) await copyRegular(join(root, name), join(payload, name));
    await copyEnvironmentExample(payload);
    for (const name of fontLicenses) {
      await copyRegular(join(root, 'assets/fonts', name), join(payload, 'licenses', name));
    }
    const releasePackage = {
      private: true,
      type: 'module',
      engines: { node: '>=22.22.0' },
      scripts: {
        start: 'node server/http.mjs',
        'assets:install': 'node deploy/install-assets.mjs',
        'nginx:config': 'node deploy/nginx.mjs',
        'bot:configure': 'node scripts/configure-admin-bot.mjs'
      }
    };
    await writeFile(join(payload, 'package.json'), `${JSON.stringify(releasePackage, null, 2)}\n`);
    const digest = await contentHash(payload);
    const name = `remgaz-server-${tag}-${digest.slice(0, 12)}.tar.gz`;
    const archive = join(artifacts, name);
    const checksum = `${archive}.sha256.txt`;
    const temporaryArchive = join(stage, name);
    const result = spawnSync('tar', ['-czf', temporaryArchive, '-C', payload, '.'], { encoding: 'utf8' });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`tar failed: ${result.stderr || result.status}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(temporaryArchive)) hash.update(chunk);
    await writeFile(join(stage, 'sha256.txt'), `${hash.digest('hex')}  ${name}\n`);
    await link(temporaryArchive, archive);
    linkedArchive = archive;
    await link(join(stage, 'sha256.txt'), checksum);
    linkedChecksum = true;
    console.log(`Release: ${relative(root, archive)}`);
    console.log(`SHA-256: ${relative(root, checksum)}`);
  } finally {
    if (linkedArchive && !linkedChecksum) await unlink(linkedArchive);
    await rm(stage, { recursive: true, force: true });
  }
}

await packageRelease();
