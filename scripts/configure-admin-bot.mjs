async function telegramRequest(botToken, method, body, fetchImpl) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('Telegram request timed out'));
    }, 10_000);
  });

  try {
    const request = (async () => {
      const response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal
      });
      if (response.ok !== true) throw new Error('Telegram HTTP failure');
      const payload = await response.json();
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          payload.ok !== true || !Object.hasOwn(payload, 'result')) {
        throw new Error('Telegram response failure');
      }
      return payload.result;
    })();
    return await Promise.race([request, deadline]);
  } catch {
    controller.abort();
    throw new Error(`Не удалось выполнить ${method} в Telegram.`);
  } finally {
    clearTimeout(timer);
  }
}

export async function configureAdminBot({ botToken, origin, fetchImpl = fetch }) {
  if (typeof botToken !== 'string' || !/^[1-9][0-9]*:[A-Za-z0-9_-]+$/.test(botToken)) {
    throw new Error('Не задан корректный TELEGRAM_BOT_TOKEN.');
  }
  let parsedOrigin;
  try { parsedOrigin = new URL(origin); }
  catch { throw new Error('PUBLIC_ORIGIN должен быть точным HTTPS origin без пути.'); }
  if (typeof origin !== 'string' || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== origin) {
    throw new Error('PUBLIC_ORIGIN должен быть точным HTTPS origin без пути.');
  }
  if (typeof fetchImpl !== 'function') throw new Error('Недоступно соединение с Telegram.');

  const url = `${origin}/admin/`;
  const bot = await telegramRequest(botToken, 'getMe', {}, fetchImpl);
  if (!bot || bot.is_bot !== true || typeof bot.username !== 'string' || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) {
    throw new Error('Telegram не подтвердил имя бота.');
  }

  const menuButton = { type: 'web_app', text: 'Управление сайтом', web_app: { url } };
  const result = await telegramRequest(botToken, 'setChatMenuButton', { menu_button: menuButton }, fetchImpl);
  if (result !== true) throw new Error('Telegram не подтвердил настройку меню.');
  const button = await telegramRequest(botToken, 'getChatMenuButton', {}, fetchImpl);
  if (!button || button.type !== menuButton.type || button.text !== menuButton.text || button.web_app?.url !== url) {
    throw new Error('Меню Telegram не совпадает с настройкой.');
  }
  return { username: bot.username, url };
}

if (import.meta.main) {
  configureAdminBot({
    botToken: process.env.TELEGRAM_BOT_TOKEN,
    origin: process.env.PUBLIC_ORIGIN
  }).then(({ username, url }) => {
    console.log(JSON.stringify({ username, url }));
  }).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
