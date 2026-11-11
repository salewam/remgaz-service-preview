import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  test(`${page}: application links and submit buttons say Оставить заявку`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
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
