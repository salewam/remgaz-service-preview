import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./build.mjs', import.meta.url));
const defaultEnv = { ...process.env };
delete defaultEnv.CONTENT_API_ORIGIN;

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'remgaz-build-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'scripts'));
  await mkdir(join(root, 'assets', 'fonts'), { recursive: true });
  await copyFile(script, join(root, 'scripts', 'build.mjs'));
  for (const page of ['index', 'gas', 'portfolio']) {
    await writeFile(join(root, `${page}.html`), '<meta name="remgaz-content-api" content="/api/content"><img src="assets/a-mobile.webp" srcset="assets/a-tablet.webp 700w, assets/a-view.webp 1000w"><script src="assets/loader.js"></script>');
  }
  await mkdir(join(root, 'admin'));
  await writeFile(join(root, 'admin/index.html'), '<script src="../assets/loader.js"></script>');
  await mkdir(join(root, 'content'));
  await writeFile(join(root, 'content/site.json'), JSON.stringify({ revision: 1, gasPriceRub: 50, projects: [{ id: 'visible', published: true, photos: [{ src: 'assets/a-view.webp' }] }, { id: 'private-draft', published: false }] }));
  for (const variant of ['mobile', 'tablet', 'view', 'lightbox']) {
    await writeFile(join(root, 'assets', `a-${variant}.webp`), variant);
  }
  await writeFile(join(root, 'assets', 'loader.js'), "const image = 'assets/a-lightbox.webp';");
  await writeFile(join(root, 'assets', 'fonts.css'), "@font-face{src:url('fonts/font.woff2')}");
  await writeFile(join(root, 'assets', 'fonts', 'font.woff2'), 'font bytes');
  await writeFile(join(root, 'assets', 'loader.test.mjs'), 'private');
  await writeFile(join(root, 'assets', 'a.webp.bak_2026'), 'private');
  return root;
}

test('build rewrites public asset URLs, retains variants, excludes private files and replaces stale output', async t => {
  const root = await fixture(t);

  const build = () => execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { encoding: 'utf8', env: defaultEnv });
  const first = build().match(/assets\/([a-f0-9]{16})\//)[1];
  assert.equal(build().match(/assets\/([a-f0-9]{16})\//)[1], first);
  const assetDir = join(root, 'dist', 'assets', first);
  const html = await readFile(join(root, 'dist', 'index.html'), 'utf8');
  assert.match(html, new RegExp(`srcset="assets/${first}/a-tablet.webp`));
  for (const page of ['index', 'gas', 'portfolio']) {
    assert.match(await readFile(join(root, 'dist', `${page}.html`), 'utf8'), /<meta name="remgaz-content-api" content="\/api\/content">/);
  }
  assert.match(await readFile(join(assetDir, 'loader.js'), 'utf8'), new RegExp(`assets/${first}/a-lightbox.webp`));
  assert.match(await readFile(join(assetDir, 'fonts.css'), 'utf8'), /url\('fonts\/font.woff2'\)/);
  assert.match(await readFile(join(root, 'dist/admin/index.html'), 'utf8'), new RegExp(`\.\./assets/${first}/loader.js`));
  const content = JSON.parse(await readFile(join(root, 'dist/content/site.json'), 'utf8'));
  assert.deepEqual(content.projects.map(project => project.id), ['visible']);
  assert.equal(content.projects[0].photos[0].src, 'assets/a-view.webp');
  assert.equal((await readdir(assetDir)).includes('loader.test.mjs'), false);
  await writeFile(join(root, 'assets', 'a-mobile.webp'), 'changed');
  const second = build().match(/assets\/([a-f0-9]{16})\//)[1];
  assert.notEqual(first, second);
  assert.deepEqual(await readdir(join(root, 'dist', 'assets')), [second]);
});

test('configured build points all public pages at live content and excludes admin and seed without changing assets', async t => {
  const root = await fixture(t);
  const build = env => execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { encoding: 'utf8', env });
  const seed = await readFile(join(root, 'content/site.json'), 'utf8');
  const tag = build(defaultEnv).match(/assets\/([a-f0-9]{16})\//)[1];
  const origin = 'https://remgaz.153-56-132-224.sslip.io';
  assert.equal(build({ ...defaultEnv, CONTENT_API_ORIGIN: origin }).match(/assets\/([a-f0-9]{16})\//)[1], tag);
  assert.deepEqual((await readdir(join(root, 'dist'))).sort(), ['assets', 'gas.html', 'index.html', 'portfolio.html']);
  for (const page of ['index', 'gas', 'portfolio']) {
    const html = await readFile(join(root, 'dist', `${page}.html`), 'utf8');
    assert.ok(html.includes(`<meta name="remgaz-content-api" content="${origin}/api/content">`));
    assert.ok(!html.includes('content="/api/content"'));
    assert.ok(html.includes(`src="assets/${tag}/a-mobile.webp"`));
  }
  await assert.rejects(readFile(join(root, 'dist/admin/index.html')), { code: 'ENOENT' });
  await assert.rejects(readFile(join(root, 'dist/content/site.json')), { code: 'ENOENT' });
  assert.equal(await readFile(join(root, 'content/site.json'), 'utf8'), seed);
  assert.match(await readFile(join(root, 'dist', 'assets', tag, 'loader.js'), 'utf8'), new RegExp(`assets/${tag}/a-lightbox.webp`));

  assert.equal(build(defaultEnv).match(/assets\/([a-f0-9]{16})\//)[1], tag);
  assert.match(await readFile(join(root, 'dist/admin/index.html'), 'utf8'), new RegExp(`\.\./assets/${tag}/loader.js`));
  assert.deepEqual(JSON.parse(await readFile(join(root, 'dist/content/site.json'), 'utf8')).projects.map(project => project.id), ['visible']);
});

test('build rejects non-exact HTTPS content origins before replacing output', async t => {
  const root = await fixture(t);
  execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], { env: defaultEnv });
  const html = await readFile(join(root, 'dist/index.html'), 'utf8');
  for (const origin of [
    '', 'not-a-url', 'http://remgaz.example', 'https://remgaz.example/',
    'https://remgaz.example/path', 'https://remgaz.example?query', 'https://remgaz.example#hash',
    'https://user:password@remgaz.example', ' https://remgaz.example',
    'https://REMGaz.example', 'https://remgaz.example:443'
  ]) {
    assert.throws(() => execFileSync(process.execPath, [join(root, 'scripts', 'build.mjs')], {
      env: { ...defaultEnv, CONTENT_API_ORIGIN: origin }, stdio: 'pipe'
    }), /CONTENT_API_ORIGIN must be a bare https origin/);
    assert.equal(await readFile(join(root, 'dist/index.html'), 'utf8'), html);
  }
});
