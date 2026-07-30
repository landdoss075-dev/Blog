import { readFile } from 'node:fs/promises';
import { log } from './log.js';

const API = (botToken, method) => `https://api.telegram.org/bot${botToken}/${method}`;

/** Rich-сообщение вмещает до 32768 символов (Bot API 10.2). */
const RICH_LIMIT = 32768;

/** Идентификатор обложки внутри Rich-сообщения (связывает <img> и media[]). */
const COVER_ID = 'cover';
const COVER_FILE_FIELD = 'cover_file';

/**
 * Тело статьи для Rich-сообщения: article.html уже валиден (санитайзер оставляет
 * h2/h3/p/ul/ol/li/b/strong/i/em/br, плюс наш CTA c <a href>). Все эти теги
 * принимает rich_message.html. Обложку встраиваем СВЕРХУ через <img src="tg://photo?id=…">
 * (само фото — в media[]), затем заголовок статьи <h1>, тело и теги. Так получается
 * один цельный пост: картинка + оформленная статья.
 */
function buildRichHtml(article, withCover) {
  const tags = (article.tags || []).map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
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
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'string' ? value : JSON.stringify(value));
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
 * статья (sendRichMessage, Bot API 10.2). Удалённая картинка передаётся через URL,
 * локальная — multipart-вложением attach://cover_file внутри того же Rich-сообщения.
 * При ошибке Rich-сообщения с обложкой не публикуем раздельные фото и текст.
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
  const hasImage = Boolean(image?.url || image?.localPath);

  if (image?.localPath) {
    return postLocalCoverAndRich(multipartCall, chat_id, article, image);
  }

  // Один Rich-пост: обложка (media[] по URL) + оформленная статья.
  const rich_message = { html: buildRichHtml(article, hasImage) };
  if (hasImage) {
    rich_message.media = [{ id: COVER_ID, media: { type: 'photo', media: image.url } }];
  }

  try {
    const r = await call('sendRichMessage', { chat_id, rich_message });
    log.ok(`Опубликовано в Telegram (Rich ${r?.message_id}${hasImage ? ' с обложкой' : ''})`);
    return { skipped: false, messageId: r?.message_id, rich: true };
  } catch (err) {
    if (hasImage) {
      throw new Error(`Единый Telegram Rich-пост с обложкой не отправлен: ${err.message}`);
    }
    log.warn(`sendRichMessage без обложки недоступен (${err.message}) — фолбэк на обычный HTML-текст.`);
    return postFallback(call, chat_id, article);
  }
}

async function postLocalCoverAndRich(multipartCall, chat_id, article, image) {
  const rich_message = {
    html: buildRichHtml(article, true),
    media: [{
      id: COVER_ID,
      media: { type: 'photo', media: `attach://${COVER_FILE_FIELD}` },
    }],
  };

  try {
    const r = await multipartCall(
      'sendRichMessage',
      { chat_id, rich_message },
      [{
        field: COVER_FILE_FIELD,
        path: image.localPath,
        filename: image.filename,
        mediaType: image.mediaType,
      }],
    );
    log.ok(`Опубликовано в Telegram (единый Rich ${r?.message_id} с локальной обложкой)`);
    return { skipped: false, messageId: r?.message_id, rich: true, localCover: true };
  } catch (err) {
    throw new Error(`Единый Telegram Rich-пост с локальной обложкой не отправлен: ${err.message}`);
  }
}

/**
 * Фолбэк только для статьи без обложки: тело статьи HTML-текстом по лимиту Telegram.
 * Telegram HTML не знает h2/ul/li — переводим заголовки в <b>, пункты в строки с «•».
 */
async function postFallback(call, chat_id, article) {
  const MSG_LIMIT = 4096;
  const tags = (article.tags || []).map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
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

  try {
    let lastId;
    for (let i = 0; i < body.length; i += MSG_LIMIT) {
      const r = await call('sendMessage', { chat_id, text: body.slice(i, i + MSG_LIMIT), parse_mode: 'HTML' });
      lastId = r?.message_id;
    }
    log.ok('Опубликовано в Telegram (фолбэк: текст без обложки)');
    return { skipped: false, messageId: lastId, lastId, rich: false, fallback: true };
  } catch (err) {
    throw new Error(`Telegram фолбэк: ${err.message}`);
  }
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
