const phoneError = 'Введите номер телефона: 10–15 цифр, допустимы +, пробелы, скобки и дефисы.';

function validatePhone(phoneInput) {
  const phone = phoneInput.value.trim();
  const digits = phone.replace(/\D/g, '');
  const validPhone = phone.length <= 40
    && /^(?:\+?\d+(?:[ -]?\(\d{1,5}\))?|\(\d{1,5}\))(?:[ -]?\d+)*$/.test(phone)
    && digits.length >= 10 && digits.length <= 15 && !/^(\d)\1+$/.test(digits);
  phoneInput.setCustomValidity(validPhone ? '' : phone.length > 40 ? 'Номер телефона не должен превышать 40 символов.' : phoneError);
  return validPhone;
}

function prepareEmail(event) {
  event.preventDefault();
  const form = event.currentTarget;
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

  const value = key => form.elements[key]?.value.trim() || '';
  const body = [
    `Имя: ${name}`,
    `Телефон: ${phone}`,
    `Тип объекта и параметры: ${value('object') || 'не указано'}`,
    `Локация: ${value('location') || 'не указана'}`
  ].join('\n');
  const subject = form.dataset.emailSubject || 'Запрос по объекту';
  window.location.href = `mailto:info@remgaz.com?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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
