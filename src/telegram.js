import { config } from './config.js';
import { log } from './log.js';

const API = (method) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

/** Rich-сообщение вмещает до 32768 символов (Bot API 10.1). */
const RICH_LIMIT = 32768;

/**
 * Тело статьи для Rich-сообщения: article.html уже валиден (санитайзер оставляет
 * h2/h3/p/ul/ol/li/b/strong/i/em/br, плюс наш CTA c <a href>). Все эти теги
 * принимает rich_message.html. Добавляем заголовок статьи как <h1> сверху и теги снизу.
 */
function buildRichHtml(article) {
  const tags = article.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
  let html = `<h1>${escapeHtml(article.title)}</h1>${article.html}`;
  if (tags) html += `<p>${escapeHtml(tags)}</p>`;
  if (html.length > RICH_LIMIT) html = html.slice(0, RICH_LIMIT);
  return html;
}

/** Вызов метода Bot API. Возвращает result или бросает с описанием. */
async function tgCall(method, payload) {
  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(`${method}: ${data.description || res.status}`);
  return data.result;
}

/**
 * Публикует пост в Telegram-канал.
 *
 * Стратегия: обложка (sendPhoto + краткий анонс) + тело статьи оформленным
 * Rich-сообщением (sendRichMessage, Bot API 10.1 — заголовки/списки/ссылки как на Дзене;
 * rich_message.html принимает наш article.html почти как есть).
 * Если Rich-сообщение недоступно/упало — фолбэк на прежний путь (полная подпись/текст).
 *
 * Если токен/канал не заданы — мягко пропускает (возвращает skipped).
 */
export async function postToTelegram(article, image) {
  if (!config.telegram.botToken || !config.telegram.channelId) {
    log.warn('TELEGRAM_BOT_TOKEN/CHANNEL_ID не заданы — пропускаю Telegram.');
    return { skipped: true };
  }
  const chat_id = config.telegram.channelId;

  // 1. Обложка — голая картинка без подписи (заголовок и всё тело идут в Rich-сообщении
  //    следом, поэтому анонс под фото не нужен — иначе дублирует статью). Без картинки
  //    обложки нет — сразу Rich-сообщение.
  let coverMsgId;
  if (image?.url) {
    try {
      const r = await tgCall('sendPhoto', { chat_id, photo: image.url });
      coverMsgId = r?.message_id;
    } catch (err) {
      // Обложка не критична: если не ушла картинка — статья всё равно уйдёт Rich-сообщением.
      log.warn(`Обложка не отправилась (${err.message}) — публикую статью без картинки.`);
    }
  }

  // 2. Тело статьи оформленным Rich-сообщением. При ошибке (фича сырая / клиент не
  //    поддерживает) не роняем публикацию: обложка уже опубликована,
  //    статью (с заголовком) добираем прежним способом — обычным текстом.
  try {
    const r = await tgCall('sendRichMessage', { chat_id, rich_message: { html: buildRichHtml(article) } });
    log.ok(`Опубликовано в Telegram (обложка ${coverMsgId} + Rich ${r?.message_id})`);
    return { skipped: false, messageId: coverMsgId, richMessageId: r?.message_id, rich: true };
  } catch (err) {
    log.warn(`sendRichMessage недоступен (${err.message}) — фолбэк на обычный текст.`);
    return postFallbackBody(chat_id, article, coverMsgId);
  }
}

/**
 * Фолбэк, если Rich-сообщение недоступно: досылаем тело как обычный HTML-текст,
 * разбивая по лимиту Telegram (4096 симв.). Обложка уже отправлена.
 * Telegram HTML не знает h2/ul/li — переводим заголовки в <b>, пункты в строки с «•».
 */
async function postFallbackBody(chat_id, article, coverMsgId) {
  const MSG_LIMIT = 4096;
  const tags = article.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
  // Обложка теперь голая — заголовок статьи несёт сам текст.
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
    let lastId = coverMsgId;
    for (let i = 0; i < body.length; i += MSG_LIMIT) {
      const r = await tgCall('sendMessage', { chat_id, text: body.slice(i, i + MSG_LIMIT), parse_mode: 'HTML' });
      lastId = r?.message_id;
    }
    log.ok(`Опубликовано в Telegram (обложка ${coverMsgId} + текст, фолбэк)`);
    return { skipped: false, messageId: coverMsgId, lastId, rich: false, fallback: true };
  } catch (err) {
    log.warn(`Фолбэк тела не удался (${err.message}); обложка с анонсом опубликована.`);
    return { skipped: false, messageId: coverMsgId, rich: false, bodyError: err.message };
  }
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
