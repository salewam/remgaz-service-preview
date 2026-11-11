import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

for (const page of ['index.html', 'gas.html', 'portfolio.html']) {
  test(`${page}: footer phone and email are native contact links`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), 'utf8');
    const footer = html.match(/<footer\b[^>]*>([\s\S]*?)<\/footer>/u)?.[1];
    assert.ok(footer, `${page}: footer exists`);
    const links = [...footer.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gu)]
      .map(([, href, content]) => ({ href, text: content.replace(/<[^>]*>/gu, '').trim() }));

    const phone = links.find(link => link.text === '8 (812) 385-53-53');
    const email = links.find(link => link.text === 'info@remgaz.com');
    assert.ok(phone, `${page}: phone number is a link, not plain text`);
    assert.ok(email, `${page}: email address is a link, not plain text`);
    assert.equal(phone.href, 'tel:+78123855353');
    assert.equal(email.href, 'mailto:info@remgaz.com');
  });
}
