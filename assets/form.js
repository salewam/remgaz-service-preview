const phoneError = 'Введите номер телефона: 10–15 цифр, допустимы +, пробелы, скобки и дефисы.';
const leadRequests = new WeakMap();

let successDialog;
let successOkButton;
let previousOverflow = '';
let activeSubmitButton = null;

function ensureSuccessDialog() {
  if (successDialog) return successDialog;
  const dialog = document.createElement('dialog');
  if (typeof dialog.showModal !== 'function') return null;
  dialog.className = 'rg-lead-modal';
  dialog.setAttribute('aria-labelledby', 'rg-lead-success-title');
  dialog.setAttribute('aria-describedby', 'rg-lead-success-desc');

  const style = document.createElement('style');
  style.textContent = `
    .rg-lead-modal:not([open]) {
      display: none;
    }
    .rg-lead-modal[open] {
      box-sizing: border-box;
      position: fixed;
      inset: 0;
      width: 100vw;
      width: 100dvw;
      height: 100vh;
      height: 100dvh;
      max-width: none;
      max-height: none;
      margin: 0;
      padding: 24px;
      border: 0;
      background: #F4F7FB;
      color: #082142;
      font-family: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow-y: auto;
      overscroll-behavior: contain;
      z-index: 99999;
    }
    .rg-lead-modal::backdrop {
      background: rgba(8, 33, 66, .75);
    }
    .rg-lead-modal__card {
      box-sizing: border-box;
      width: 100%;
      max-width: 520px;
      margin: auto;
      padding: 40px 32px;
      background: #ffffff;
      border-radius: 16px;
      box-shadow: 0 12px 36px rgba(8, 33, 66, .12);
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 20px;
    }
    .rg-lead-modal__title {
      margin: 0;
      font-size: clamp(24px, 4vw, 32px);
      font-weight: 700;
      line-height: 1.25;
      color: #082142;
    }
    .rg-lead-modal__desc {
      margin: 0;
      font-size: clamp(16px, 2.5vw, 18px);
      line-height: 1.5;
      color: #4b617d;
    }
    .rg-lead-modal__ok {
      box-sizing: border-box;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 160px;
      min-height: 48px;
      padding: 12px 32px;
      margin-top: 8px;
      border: 0;
      border-radius: 8px;
      background: #004D99;
      color: #ffffff;
      font-family: inherit;
      font-size: 17px;
      font-weight: 600;
      cursor: pointer;
      text-decoration: none;
      transition: background-color .15s ease;
    }
    .rg-lead-modal__ok:hover,
    .rg-lead-modal__ok:focus-visible {
      background: #003870;
      outline: 2px solid #004D99;
      outline-offset: 2px;
    }
  `;
  document.head.append(style);

  const card = document.createElement('div');
  card.className = 'rg-lead-modal__card';

  const title = document.createElement('h2');
  title.className = 'rg-lead-modal__title';
  title.id = 'rg-lead-success-title';
  title.textContent = 'Ваша заявка отправлена';

  const desc = document.createElement('p');
  desc.className = 'rg-lead-modal__desc';
  desc.id = 'rg-lead-success-desc';
  desc.textContent = 'Мы свяжемся с вами в ближайшее время.';

  const okBtn = document.createElement('button');
  okBtn.type = 'button';
  okBtn.className = 'rg-lead-modal__ok';
  okBtn.textContent = 'Окей';
  okBtn.addEventListener('click', () => dialog.close());

  card.append(title, desc, okBtn);
  dialog.append(card);

  dialog.addEventListener('close', () => {
    document.body.style.overflow = previousOverflow;
    if (activeSubmitButton?.isConnected) {
      activeSubmitButton.focus({ preventScroll: true });
    }
    activeSubmitButton = null;
  });

  document.body.append(dialog);
  successDialog = dialog;
  successOkButton = okBtn;
  return successDialog;
}

function showSuccessModal(submitButton) {
  const dialog = ensureSuccessDialog();
  if (!dialog) return;
  activeSubmitButton = submitButton;
  if (!dialog.open) {
    previousOverflow = document.body.style.overflow;
    dialog.showModal();
    document.body.style.overflow = 'hidden';
    successOkButton?.focus?.({ preventScroll: true });
  }
}

function validatePhone(phoneInput) {
  const phone = phoneInput.value.trim();
  const digits = phone.replace(/\D/g, '');
  const validPhone = phone.length <= 40
    && /^(?:\+?\d+(?:[ -]?\(\d{1,5}\))?|\(\d{1,5}\))(?:[ -]?\d+)*$/.test(phone)
    && digits.length >= 10 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
  phoneInput.setCustomValidity(validPhone ? '' : phone.length > 40 ? 'Номер телефона не должен превышать 40 символов.' : phoneError);
  return validPhone;
}

async function submitLead(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = form.querySelector('button[type="submit"]');
  if (button.disabled) return;
  const nameInput = form.elements.name;
  const phoneInput = form.elements.phone;
  const name = nameInput.value.trim();
  const phone = phoneInput.value.trim();
  nameInput.setCustomValidity(!name ? 'Укажите ваше имя.' : name.length > 100 ? 'Имя не должно превышать 100 символов.' : '');
  for (const key of ['object', 'location']) {
    const input = form.elements[key];
    if (!input) continue;
    const text = input.value.trim();
    input.setCustomValidity(input.required && !text ? 'Заполните это поле.' : text.length > 200 ? 'Не больше 200 символов.' : '');
  }
  validatePhone(phoneInput);
  if (!form.reportValidity()) return;

  const status = form.querySelector('[data-form-status]');
  const label = button.textContent;
  const body = JSON.stringify({
    name, phone,
    object: form.elements.object?.value.trim() || '',
    location: form.elements.location?.value.trim() || ''
  });
  let submission = leadRequests.get(form);
  if (!submission || submission.body !== body) {
    submission = { body, key: crypto.randomUUID() };
    leadRequests.set(form, submission);
  }
  button.disabled = true;
  button.textContent = 'Отправляем…';
  status.textContent = 'Отправляем заявку…';
  try {
    const apiURL = new URL(document.querySelector('meta[name="remgaz-content-api"]')?.content || '/api/content', document.baseURI);
    const response = await fetch(new URL('/api/lead', apiURL), {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': submission.key }, body
    });
    const result = await response.json();
    if (!response.ok || result?.ok !== true || !['sent', 'queued'].includes(result.delivery)) {
      status.textContent = result?.error || 'Не удалось отправить заявку. Повторите попытку или позвоните нам.';
      return;
    }
    status.textContent = 'Заявка принята и сохранена. Мы свяжемся с вами по указанному телефону.';
    showSuccessModal(button);
  } catch {
    status.textContent = 'Не удалось подтвердить отправку. Данные остались в форме. Повторите попытку или позвоните нам.';
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

document.querySelectorAll('form.editorial-form').forEach(form => {
  for (const key of ['name', 'phone', 'object', 'location']) {
    form.elements[key]?.addEventListener('input', event => event.currentTarget.setCustomValidity(''));
  }
  const phoneInput = form.elements.phone;
  phoneInput?.addEventListener('invalid', () => {
    if (!phoneInput.validity.customError) phoneInput.setCustomValidity(phoneError);
  });
});
