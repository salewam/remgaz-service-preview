import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  test(`${page}: request forms and non-hero links say Оставить заявку`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8')
      .replace(/<div class="hero-actions-row">[\s\S]*?<\/div>/u, '');
    let actions = 0;

    for (const [, tag, attributes, content] of html.matchAll(/<(a|button)\b([^>]*)>([\s\S]*?)<\/\1>/gu)) {
      const label = content.replace(/<[^>]*>/gu, '').trim();
      const href = attributes.match(/\bhref="([^"]*)"/u)?.[1];
      const applicationLink = tag === 'a' && href?.endsWith('#contact') && label !== 'Контакты';
      const submitButton = tag === 'button' && /\btype="submit"/u.test(attributes);
      if (!applicationLink && !submitButton) continue;

      actions += 1;
      assert.equal(label, 'Оставить заявку', `${page}: ${href || 'form submission'}`);
    }

    assert.ok(actions > 0, `${page}: application actions exist`);
  });
}

test('homepage hero distinguishes engineering and gas requests with the right destinations', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const hero = html.match(/<div class="hero-actions-row">([\s\S]*?)<\/div>/u)?.[1];
  assert.ok(hero, 'homepage actions exist');
  const links = [...hero.matchAll(/<a\b[^>]*href="([^"]*)"[^>]*>([^<]+)<\/a>/gu)]
    .map(([, href, text]) => ({ href, text }));
  assert.deepEqual(links, [
    { href: '#contact', text: 'Связаться с инженером' },
    { href: '#objects', text: 'Выбрать объект' },
    { href: 'gas.html#contact', text: 'Заказать газ' },
  ]);
});
