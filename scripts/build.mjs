import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, lstat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsRoot = join(root, 'assets');
const destination = join(root, 'dist');
const pages = ['index.html', 'gas.html', 'portfolio.html', 'admin/index.html'];
const contentFile = 'content/site.json';
const publicExtension = /\.(?:css|js|webp|avif|png|jpe?g|svg|gif|ico|woff2?)$/i;
const excludedName = /(?:^\.|\.test\.|\.bak_|\.spec\.)/i;
const contentApiOrigin = process.env.CONTENT_API_ORIGIN;
if (contentApiOrigin !== undefined) {
  try {
    const parsed = new URL(contentApiOrigin);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.origin !== contentApiOrigin) throw new Error();
  } catch { throw new Error('CONTENT_API_ORIGIN must be a bare https origin'); }
}

async function assetsIn(directory = assetsRoot) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link in assets: ${relative(root, path)}`);
    if (excludedName.test(entry.name)) continue;
    if (entry.isDirectory()) found.push(...await assetsIn(path));
    else if (entry.isFile() && publicExtension.test(entry.name)) found.push(relative(assetsRoot, path));
  }
  return found.sort();
}

async function checkOwnedDist() {
  let stat;
  try { stat = await lstat(destination); } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dist is not a regular directory');
  async function inspect(directory, prefix = '') {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const pathname = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Refusing to replace dist containing a symlink: ${pathname}`);
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (pages.includes(name) && entry.isFile()) continue;
      if (name === contentFile && entry.isFile()) continue;
      if (['admin', 'content'].includes(name) && entry.isDirectory()) { await inspect(pathname, name); continue; }
      if (name === 'assets' && entry.isDirectory()) { await inspect(pathname, name); continue; }
      if (/^assets\/[a-f0-9]{16}$/.test(name) && entry.isDirectory()) { await inspect(pathname, name); continue; }
      const match = /^assets\/[a-f0-9]{16}\/(.+)$/.exec(name);
      if (match && entry.isDirectory()) { await inspect(pathname, name); continue; }
      if (match && entry.isFile() && publicExtension.test(match[1]) &&
        match[1].split('/').every(part => !excludedName.test(part))) continue;
      throw new Error(`Refusing to replace dist containing an unrelated entry: ${name}`);
    }
  }
  await inspect(destination);
  return true;
}

const assetNames = await assetsIn();
const files = [...pages, contentFile, ...assetNames.map(name => `assets/${name}`)].sort();
const input = new Map();
const hash = createHash('sha256');
for (const name of files) {
  const contents = await readFile(join(root, name));
  input.set(name, contents);
  hash.update(`${name}\0${contents.length}\0`);
  hash.update(contents);
}
const tag = hash.digest('hex').slice(0, 16);
const existing = await checkOwnedDist();
const staged = await mkdtemp(join(root, '.remgaz-build-'));
const previous = `${staged}-previous`;
let movedOld = false;
try {
  const rewrite = text => text.replace(/\bassets\//g, `assets/${tag}/`);
  for (const page of pages) {
    if (contentApiOrigin && page === 'admin/index.html') continue;
    await mkdir(dirname(join(staged, page)), { recursive: true });
    const html = rewrite(input.get(page).toString('utf8'));
    await writeFile(join(staged, page), contentApiOrigin
      ? html.replace('<meta name="remgaz-content-api" content="/api/content">', `<meta name="remgaz-content-api" content="${contentApiOrigin}/api/content">`)
      : html);
  }
  if (!contentApiOrigin) {
    const seed = JSON.parse(input.get(contentFile).toString('utf8'));
    if (!Array.isArray(seed.projects)) throw new Error('Site content must include projects');
    await mkdir(join(staged, 'content'));
    await writeFile(join(staged, contentFile), `${JSON.stringify({ ...seed, projects: seed.projects.filter(project => project.published) })}\n`);
  }
  for (const name of assetNames) {
    const target = join(staged, 'assets', tag, name);
    await mkdir(dirname(target), { recursive: true });
    const original = input.get(`assets/${name}`);
    await writeFile(target, name.endsWith('.js') ? rewrite(original.toString('utf8')) : original);
  }
  if (existing) {
    await rename(destination, previous);
    movedOld = true;
  }
  try { await rename(staged, destination); }
  catch (error) {
    if (movedOld) await rename(previous, destination);
    movedOld = false;
    throw error;
  }
  if (movedOld) await rm(previous, { recursive: true, force: true });
  console.log(`Built dist/assets/${tag}/ (${assetNames.length} assets)`);
} catch (error) {
  await rm(staged, { recursive: true, force: true });
  throw error;
}
