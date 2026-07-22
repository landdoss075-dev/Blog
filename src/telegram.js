import { readFile } from 'node:fs/promises';
import { log } from './log.js';

const API = (botToken, method) => `https://api.telegram.org/bot${botToken}/${method}`;

/** Rich-сообщение вмещает до 32768 символов (Bot API 10.1). */
const RICH_LIMIT = 32768;

/** Идентификатор обложки внутри Rich-сообщения (связывает <img> и media[]). */
const COVER_ID = 'cover';

/**
 * Тело статьи для Rich-сообщения: article.html уже валиден (санитайзер оставляет
 * h2/h3/p/ul/ol/li/b/strong/i/em/br, плюс наш CTA c <a href>). Все эти теги
 * принимает rich_message.html. Обложку встраиваем СВЕРХУ через <img src="tg://photo?id=…">
 * (само фото — в media[]), затем заголовок статьи <h1>, тело и теги. Так получается
 * один цельный пост: картинка + оформленная статья.
 */
function buildRichHtml(article, withCover) {
  const tags = article.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
  let html = withCover ? `<img src="tg://photo?id=${COVER_ID}">` : '';
  html += `<h1>${escapeHtml(article.title)}</h1>${article.html}`;
  if (tags) html += `<p>${escapeHtml(tags)}</p>`;
  if (html.length > RICH_LIMIT) html = html.slice(0, RICH_LIMIT);
  return html;
}

/** Вызов метода Bot API. Возвращает result или бросает с описанием. */
async function tgCall(botToken, method, payload) {
  const res = await fetch(API(botToken, method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

async function tgMultipartCall(botToken, method, fields, files) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) form.set(key, String(value));
  }
  for (const file of files) {
    const bytes = await readFile(file.path);
    form.set(file.field, new Blob([bytes], { type: file.mediaType || 'image/jpeg' }), file.filename || 'image.jpg');
  }
  const res = await fetch(API(botToken, method), { method: 'POST', body: form });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

/**
 * Публикует пост в Telegram-канал ОДНИМ Rich-сообщением: обложка сверху + оформленная
 * статья (sendRichMessage, Bot API 10.1). Картинка встраивается через media[] по URL
 * (Telegram сам скачивает по HTTP-ссылке — file_id не нужен).
 * Если Rich-сообщение недоступно/упало — фолбэк на прежний путь (фото + обычный текст).
 *
 * `tg` — таргет ниши: { botToken, channelId }. Если не заданы — мягко пропускает.
 */
export async function postToTelegram(article, image, tg) {
  if (!tg?.botToken || !tg?.channelId) {
    log.warn('Токен бота / id канала ниши не заданы — пропускаю Telegram.');
    return { skipped: true };
  }
  const call = (method, payload) => tgCall(tg.botToken, method, payload);
  const multipartCall = (method, fields, files) => tgMultipartCall(tg.botToken, method, fields, files);
  const chat_id = tg.channelId;
  const hasImage = Boolean(image?.url);

  if (image?.localPath) {
    log.info('Обложка локальная — отправляю в Telegram загрузкой файла.');
    return postFallback(call, chat_id, article, image, multipartCall);
  }

  // Один Rich-пост: обложка (media[] по URL) + оформленная статья. При ошибке
  // (фича сырая / клиент не поддерживает) не роняем публикацию — фолбэк на фото+текст.
  const rich_message = { html: buildRichHtml(article, hasImage) };
  if (hasImage) {
    rich_message.media = [{ id: COVER_ID, media: { type: 'photo', media: image.url } }];
  }

  try {
    const r = await call('sendRichMessage', { chat_id, rich_message });
    log.ok(`Опубликовано в Telegram (Rich ${r?.message_id}${hasImage ? ' с обложкой' : ''})`);
    return { skipped: false, messageId: r?.message_id, rich: true };
  } catch (err) {
    log.warn(`sendRichMessage недоступен (${err.message}) — фолбэк на фото + обычный текст.`);
    return postFallback(call, chat_id, article, image, multipartCall);
  }
}

/**
 * Фолбэк, если Rich-сообщение недоступно: обычный пост — голая обложка (если есть) +
 * тело статьи HTML-текстом, разбитое по лимиту Telegram (4096 симв.).
 * Telegram HTML не знает h2/ul/li — переводим заголовки в <b>, пункты в строки с «•».
 */
async function postFallback(call, chat_id, article, image, multipartCall = null) {
  const MSG_LIMIT = 4096;
  const tags = article.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
  let body = `<b>${escapeHtml(article.title)}</b>\n\n` + article.html
    .replace(/<h2[^>]*>/gi, '\n<b>').replace(/<\/h2>/gi, '</b>\n')
    .replace(/<h3[^>]*>/gi, '\n<b>').replace(/<\/h3>/gi, '</b>\n')
    .replace(/<li[^>]*>/gi, '• ').replace(/<\/li>/gi, '\n')
    .replace(/<\/?(p|ul|ol)[^>]*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<strong>/gi, '<b>').replace(/<\/strong>/gi, '</b>')
    .replace(/<em>/gi, '<i>').replace(/<\/em>/gi, '</i>')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (tags) body += `\n\n${tags}`;

  let coverMsgId;
  if (image?.url) {
    try {
      const r = image.localPath && multipartCall
        ? await multipartCall(
          'sendPhoto',
          { chat_id },
          [{ field: 'photo', path: image.localPath, filename: image.filename, mediaType: image.mediaType }],
        )
        : await call('sendPhoto', { chat_id, photo: image.url });
      coverMsgId = r?.message_id;
    } catch (err) {
      log.warn(`Обложка (фолбэк) не отправилась (${err.message}) — публикую текст без картинки.`);
    }
  }
  try {
    let lastId = coverMsgId;
    for (let i = 0; i < body.length; i += MSG_LIMIT) {
      const r = await call('sendMessage', { chat_id, text: body.slice(i, i + MSG_LIMIT), parse_mode: 'HTML' });
      lastId = r?.message_id;
    }
    log.ok(`Опубликовано в Telegram (фолбэк: ${coverMsgId ? 'обложка + ' : ''}текст)`);
    return { skipped: false, messageId: coverMsgId ?? lastId, lastId, rich: false, fallback: true };
  } catch (err) {
    // Если и текст не ушёл, но обложка отправилась — пост частично состоялся.
    if (coverMsgId) {
      log.warn(`Фолбэк тела не удался (${err.message}); обложка опубликована.`);
      return { skipped: false, messageId: coverMsgId, rich: false, bodyError: err.message };
    }
    throw new Error(`Telegram фолбэк: ${err.message}`);
  }
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
