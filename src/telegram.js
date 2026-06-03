import { config } from './config.js';
import { log } from './log.js';

const API = (method) => `https://api.telegram.org/bot${config.telegram.botToken}/${method}`;

/** Telegram-подпись к фото ограничена 1024 символами. */
const CAPTION_LIMIT = 1024;

function buildCaption(article) {
  const tags = article.tags.map((t) => '#' + t.replace(/\s+/g, '_')).join(' ');
  const parts = [`<b>${escapeHtml(article.title)}</b>`, '', article.telegram];
  if (tags) parts.push('', tags);
  let caption = parts.join('\n');
  if (caption.length > CAPTION_LIMIT) {
    caption = caption.slice(0, CAPTION_LIMIT - 1) + '…';
  }
  return caption;
}

/**
 * Публикует пост в Telegram-канал.
 * Если токен/канал не заданы — мягко пропускает (возвращает skipped).
 */
export async function postToTelegram(article, image) {
  if (!config.telegram.botToken || !config.telegram.channelId) {
    log.warn('TELEGRAM_BOT_TOKEN/CHANNEL_ID не заданы — пропускаю Telegram.');
    return { skipped: true };
  }

  const caption = buildCaption(article);

  // С картинкой — sendPhoto, без — sendMessage.
  const method = image?.url ? 'sendPhoto' : 'sendMessage';
  const payload = image?.url
    ? { chat_id: config.telegram.channelId, photo: image.url, caption, parse_mode: 'HTML' }
    : { chat_id: config.telegram.channelId, text: caption, parse_mode: 'HTML' };

  const res = await fetch(API(method), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  const data = await res.json();
  if (!data.ok) {
    throw new Error(`Telegram ${method}: ${data.description || res.status}`);
  }

  log.ok(`Опубликовано в Telegram (message_id: ${data.result?.message_id})`);
  return { skipped: false, messageId: data.result?.message_id };
}

function escapeHtml(s = '') {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
