(() => {
  'use strict';

  let dialog;
  let number;
  let call;
  let message;
  let opener;
  let previousOverflow;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createDialog() {
    const panel = element('dialog', 'rg-phone');
    if (typeof panel.showModal !== 'function') return false;
    dialog = panel;
    dialog.setAttribute('aria-labelledby', 'rg-phone-title');
    dialog.setAttribute('aria-describedby', 'rg-phone-help');
    const style = document.createElement('style');
    style.textContent = `
      .rg-phone {
        box-sizing: border-box; width: min(420px, calc(100vw - 32px));
        max-height: calc(100vh - 32px); max-height: calc(100dvh - 32px);
        margin: auto; padding: 0; overflow: auto; overscroll-behavior: contain;
        border: 1px solid var(--line-light, #dce5f0); border-radius: 8px;
        background: #fff; color: #0a192f; font-family: inherit;
      }
      .rg-phone::backdrop { background: rgba(5, 21, 43, .55); }
      .rg-phone__body { display: grid; gap: 18px; min-width: 0; padding: 22px; }
      .rg-phone__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
      .rg-phone__title { min-width: 0; margin: 0; font-size: 22px; line-height: 1.3; }
      .rg-phone__close {
        flex: none; width: 44px; height: 44px; border: 0; border-radius: 4px;
        background: transparent; color: inherit; font-family: inherit; font-size: 28px; line-height: 1; cursor: pointer;
      }
      .rg-phone__number {
        box-sizing: border-box; width: 100%; min-width: 0; min-height: 48px; margin: 0;
        padding: 8px 0; border: 0; border-radius: 0; background: transparent;
        color: inherit; font-family: inherit; font-size: clamp(20px, 5vw, 28px);
        line-height: 1.4; font-weight: 700; text-align: center;
      }
      .rg-phone__actions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 9rem), 1fr)); gap: 10px; }
      .rg-phone__actions > * {
        box-sizing: border-box; display: flex; align-items: center; justify-content: center;
        min-width: 0; min-height: 48px; padding: 11px 12px; border: 1px solid #004d99;
        border-radius: 6px; font: inherit; font-weight: 700; text-decoration: none;
        text-align: center; overflow-wrap: anywhere; cursor: pointer;
      }
      .rg-phone__call { background: #004d99; color: #fff; }
      .rg-phone__copy { background: #fff; color: #004d99; }
      .rg-phone__help, .rg-phone__message { margin: 0; color: #536578; font-size: 13px; line-height: 1.5; }
      .rg-phone__message:empty { display: none; }
      .rg-phone :focus-visible { outline: 3px solid #0076c8; outline-offset: 3px; }
    `;
    document.head.append(style);
    const body = element('div', 'rg-phone__body');
    const header = element('div', 'rg-phone__header');
    const title = element('h2', 'rg-phone__title', 'Позвонить нам');
    title.id = 'rg-phone-title';
    const close = element('button', 'rg-phone__close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Закрыть номер телефона');
    close.addEventListener('click', () => dialog.close());
    header.append(title, close);
    number = element('input', 'rg-phone__number');
    number.type = 'tel';
    number.readOnly = true;
    number.setAttribute('aria-label', 'Номер телефона');
    const actions = element('div', 'rg-phone__actions');
    call = element('a', 'rg-phone__call', 'Набрать номер');
    const copy = element('button', 'rg-phone__copy', 'Скопировать');
    copy.type = 'button';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(call.getAttribute('href').slice(4));
        message.textContent = 'Номер скопирован.';
      } catch {
        number.focus();
        number.select();
        message.textContent = 'Не удалось скопировать автоматически. Скопируйте выделенный номер.';
      }
    });
    actions.append(call, copy);
    const help = element('p', 'rg-phone__help', '«Набрать номер» откроет приложение для звонков, если оно есть. Если звонить с этого устройства нельзя, скопируйте номер.');
    help.id = 'rg-phone-help';
    message = element('p', 'rg-phone__message');
    message.setAttribute('role', 'status');
    message.setAttribute('aria-live', 'polite');
    body.append(header, number, actions, help, message);
    dialog.append(body);
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => {
      document.body.style.overflow = previousOverflow;
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    });
    document.body.append(dialog);
    return true;
  }

  document.addEventListener('click', event => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const link = event.target.closest?.('a[href^="tel:"]');
    if (!link || link === call) return;
    if (!dialog && !createDialog()) return;
    event.preventDefault();
    opener = link;
    const href = link.getAttribute('href');
    number.value = href.slice(4).replace(/^\+7(\d{3})(\d{3})(\d{2})(\d{2})$/, '+7 ($1) $2-$3-$4');
    call.setAttribute('href', href);
    message.textContent = '';
    if (!dialog.open) {
      previousOverflow = document.body.style.overflow;
      dialog.showModal();
      document.body.style.overflow = 'hidden';
      call.focus({ preventScroll: true });
    }
  });
})();
