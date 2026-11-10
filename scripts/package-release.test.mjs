import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const script = fileURLToPath(new URL('./package-release.mjs', import.meta.url));
const tag = '0123456789abcdef';

test('release contains only executable runtime, keeps safe settings and names backend changes separately', async t => {
  const root = await mkdtemp(join(tmpdir(), 'remgaz-release-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const dir of ['scripts', 'server', 'content', 'deploy', 'assets/fonts', 'dist/admin', 'dist/content', `dist/assets/${tag}`]) {
    await mkdir(join(root, dir), { recursive: true });
  }
  await copyFile(script, join(root, 'scripts/package-release.mjs'));
  for (const page of ['index', 'gas', 'portfolio']) {
    await writeFile(join(root, 'dist', `${page}.html`), `<img src="assets/${tag}/image.webp">`);
  }
  await writeFile(join(root, 'dist/admin/index.html'), `<script src="../assets/${tag}/image.webp"></script>`);
  await writeFile(join(root, 'content/site.json'), '{"revision":1,"gasPriceRub":50,"projects":[]}');
  await writeFile(join(root, 'dist/content/site.json'), '{"revision":1,"gasPriceRub":50,"projects":[]}');
  await writeFile(join(root, 'scripts/configure-admin-bot.mjs'), 'export const configureAdminBot = () => {};');
  await writeFile(join(root, 'dist', 'assets', tag, 'image.webp'), 'public image');
  for (const name of ['http', 'lead', 'config', 'content', 'telegram-admin']) await writeFile(join(root, 'server', `${name}.mjs`), `export const name = '${name}';\n`);
  for (const name of ['install-assets.mjs', 'nginx.mjs', 'remgaz.service']) {
    await writeFile(join(root, 'deploy', name), `runtime ${name}\n`);
  }
  const secrets = ['sample-origin.invalid', 'SAMPLE_BOT_SECRET', 'SAMPLE_CHAT_SECRET', 'SAMPLE_IP_SECRET', 'SAMPLE_TURNSTILE_SECRET'];
  await writeFile(join(root, 'deploy/server.env.example'), [
    '# Configure privately outside dist',
    `PUBLIC_ORIGIN=https://${secrets[0]}`,
    `TELEGRAM_BOT_TOKEN=${secrets[1]}`,
    `TELEGRAM_CHAT_ID=${secrets[2]}`,
    `LEAD_IP_HASH_SECRET=${secrets[3]}`,
    'LEAD_DB_PATH=/var/lib/remgaz/leads.sqlite',
    'HOST=127.0.0.1',
    'PORT=8080',
    'TRUST_PROXY=true',
    `TURNSTILE_SECRET=${secrets[4]}`,
    'TELEGRAM_ADMIN_IDS=123456789',
    'CONTENT_DB_PATH=/var/lib/remgaz/content.sqlite',
    'CONTENT_MEDIA_DIR=/var/lib/remgaz/media',
    ''
  ].join('\n'));
  for (const name of ['manrope-OFL.txt', 'plus-jakarta-sans-OFL.txt', 'jetbrains-mono-OFL.txt']) {
    await writeFile(join(root, 'assets/fonts', name), `SIL OPEN FONT LICENSE ${name}`);
  }
  await writeFile(join(root, 'server/http.test.mjs'), 'private test');
  await writeFile(join(root, 'server/config.mjs.bak_2026'), 'private backup');
  await writeFile(join(root, 'server/phone-cases.json'), 'private fixture');
  await writeFile(join(root, 'deploy/server.env'), 'private credentials');
  await writeFile(join(root, '.env'), 'private credentials');

  const release = () => {
    const output = execFileSync(process.execPath, [join(root, 'scripts/package-release.mjs')], { encoding: 'utf8' });
    const match = output.match(/Release: (artifacts\/remgaz-server-([a-f0-9]{16})-[a-f0-9]{12}\.tar\.gz)/);
    assert.ok(match, output);
    assert.equal(match[2], tag);
    return join(root, match[1]);
  };
  const archive = release();
  const checksum = await readFile(`${archive}.sha256.txt`, 'utf8');
  assert.equal(checksum, `${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`);
  const unpacked = join(root, 'unpacked');
  await mkdir(unpacked);
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const entries = (await readdir(unpacked, { recursive: true })).sort();
  assert.deepEqual(entries, [
    'dist', 'deploy', 'content', 'licenses', 'package.json', 'server', 'scripts',
    'content/site.json', 'scripts/configure-admin-bot.mjs',
    `dist/assets`, `dist/assets/${tag}`, `dist/assets/${tag}/image.webp`,
    'dist/admin', 'dist/admin/index.html', 'dist/index.html', 'dist/gas.html', 'dist/portfolio.html',
    'dist/content', 'dist/content/site.json',
    'deploy/server.env.example', 'deploy/install-assets.mjs', 'deploy/nginx.mjs', 'deploy/remgaz.service',
    'licenses/manrope-OFL.txt', 'licenses/plus-jakarta-sans-OFL.txt', 'licenses/jetbrains-mono-OFL.txt',
    'server/http.mjs', 'server/lead.mjs', 'server/config.mjs', 'server/content.mjs', 'server/telegram-admin.mjs'
  ].sort());
  const env = await readFile(join(unpacked, 'deploy/server.env.example'), 'utf8');
  for (const secret of secrets) assert.equal(env.includes(secret), false);
  for (const line of ['LEAD_DB_PATH=/var/lib/remgaz/leads.sqlite', 'CONTENT_DB_PATH=/var/lib/remgaz/content.sqlite', 'CONTENT_MEDIA_DIR=/var/lib/remgaz/media', 'HOST=127.0.0.1', 'PORT=8080', 'TRUST_PROXY=true']) {
    assert.ok(env.includes(`${line}\n`));
  }
  for (const name of ['PUBLIC_ORIGIN', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'LEAD_IP_HASH_SECRET', 'TURNSTILE_SECRET', 'TELEGRAM_ADMIN_IDS']) {
    assert.match(env, new RegExp(`^${name}=$`, 'm'));
  }
  const scripts = JSON.parse(await readFile(join(unpacked, 'package.json'), 'utf8')).scripts;
  assert.deepEqual(Object.keys(scripts).sort(), ['assets:install', 'bot:configure', 'nginx:config', 'start']);
  await writeFile(join(root, 'server/http.mjs'), 'new backend contents');
  const updatedArchive = release();
  assert.notEqual(updatedArchive, archive);
  assert.equal(`${createHash('sha256').update(await readFile(archive)).digest('hex')}  ${basename(archive)}\n`, checksum);
  assert.equal((await readdir(join(root, 'artifacts'))).some(name => name.startsWith('.remgaz-release-')), false);
});
