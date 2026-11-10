import { createHash } from 'node:crypto';
import { cp, chmod, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const localDist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const dist = resolve(process.env.RELEASE_DIST || localDist);
const shared = process.env.SHARED_ASSETS;
if (!shared || !isAbsolute(shared) || !shared.endsWith('/assets')) {
  throw new Error('Set SHARED_ASSETS to an absolute persistent /assets directory');
}
const outside = (a, b) => {
  const path = relative(a, b);
  return path && path !== '..' && !path.startsWith(`..${sep}`);
};
if (outside(dist, shared) || outside(shared, dist) || shared === dist) {
  throw new Error('Shared assets and release dist must be separate');
}
const releases = await readdir(join(dist, 'assets'));
if (releases.length !== 1 || !/^[a-f0-9]{16}$/.test(releases[0])) {
  throw new Error('Release dist must contain exactly one versioned assets directory');
}
const tag = releases[0];
for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  const html = await readFile(join(dist, page), 'utf8');
  if (!html.includes(`assets/${tag}/`)) throw new Error(`${page} does not reference current assets`);
}
const source = join(dist, 'assets', tag);
const sourceEntry = await lstat(source);
if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) {
  throw new Error('Versioned assets must be a regular directory');
}
async function digestTree(directory, prefix = '') {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || /\.bak_|\.test\.|\.spec\./.test(entry.name)) {
      throw new Error(`Non-public asset: ${name}`);
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await digestTree(path, name));
    else if (entry.isFile() && /\.(?:css|js|webp|avif|png|jpe?g|svg|gif|ico|woff2?)$/i.test(name)) {
      result.push(`${name}\0${createHash('sha256').update(await readFile(path)).digest('hex')}`);
    } else throw new Error(`Non-public asset: ${name}`);
  }
  return result.sort();
}
const expected = await digestTree(source);
await mkdir(shared, { recursive: true });
const target = join(shared, tag);
let exists = false;
try {
  const entry = await lstat(target);
  if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('Existing asset version is not a regular directory');
  exists = true;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
if (exists) {
  if (JSON.stringify(await digestTree(target)) !== JSON.stringify(expected)) {
    throw new Error(`Existing assets/${tag} differs: never overwrite a published version`);
  }
  console.log(`assets/${tag} already installed unchanged`);
} else {
  const stage = await mkdtemp(join(shared, '.remgaz-assets-'));
  try {
    for (const name of await readdir(source)) await cp(join(source, name), join(stage, name), { recursive: true });
    if (JSON.stringify(await digestTree(stage)) !== JSON.stringify(expected)) throw new Error('Asset copy verification failed');
    await chmod(stage, 0o755);
    await rename(stage, target);
    console.log(`Installed assets/${tag}; older asset versions retained`);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}
