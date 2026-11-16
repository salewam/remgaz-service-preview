const phoneError = 'Введите номер телефона: 10–15 цифр, допустимы +, пробелы, скобки и дефисы.';
const leadRequests = new WeakMap();

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
  phoneInput?.addEventListener('blur', () => {
    if (!validatePhone(phoneInput)) phoneInput.reportValidity();
  });
});
