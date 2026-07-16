/**
 * Ручная публикация статьи в Telegram-канал одним оформленным Rich-постом
 * (обложка + заголовок + тело). Переиспользует боевую src/telegram.js.
 *
 * Использование:
 *   node scripts/post_to_telegram.js --file article.json
 *   node scripts/post_to_telegram.js --url https://atmoapp.ru/blog/<slug>
 *   node scripts/post_to_telegram.js --rss-latest        # последняя статья из RSS atmoapp
 *   node scripts/post_to_telegram.js --rss-match "часть заголовка"
 *
 * Опции:
 *   --chat @channel_or_id   куда слать (по умолчанию TELEGRAM_CHANNEL_ID из .env)
 *   --dry                   не отправлять, только показать, что уйдёт
 *
 * Формат --file (JSON): { "title": "...", "html": "<p>...</p>", "imageUrl": "https://..." }
 * (tags/telegram необязательны).
 */
import { readFile } from 'node:fs/promises';
import Parser from 'rss-parser';
import { config } from '../src/config.js';
import { postToTelegram } from '../src/telegram.js';
import { log } from '../src/log.js';

const ATMO_RSS = 'https://atmoapp.ru/blog/rss.xml';

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 ? (process.argv[i + 1] ?? true) : def;
}

/** Убирает инлайн-<img> из тела: в Telegram Rich они не рендерятся по URL (нужна media-привязка).
 *  Обложку добавит telegram.js через image → media[]. */
function stripInlineImages(html) {
  return String(html || '').replace(/<img[^>]*>/gi, '').replace(/<p>\s*<\/p>/gi, '');
}

function decode(s) {
  return String(s || '')
    .replace(/&quot;/g, '"').replace(/&laquo;/g, '«').replace(/&raquo;/g, '»')
    .replace(/&mdash;/g, '—').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

/** Достаёт статью из RSS-ленты atmoapp по индексу (0 = последняя) или по подстроке заголовка. */
async function fromRss({ match }) {
  const parser = new Parser({
    timeout: 20000,
    customFields: { item: [['content:encoded', 'contentEncoded']] },
  });
  const feed = await parser.parseURL(ATMO_RSS);
  const items = feed.items || [];
  if (!items.length) throw new Error('RSS пуст');
  let item;
  if (match) {
    const m = String(match).toLowerCase();
    item = items.find((it) => decode(it.title).toLowerCase().includes(m));
    if (!item) throw new Error(`В RSS не нашёл статью со словами: «${match}»`);
  } else {
    item = items[0]; // последняя опубликованная
  }
  const imageUrl = (item.enclosure?.url || '').replace(/&amp;/g, '&');
  return {
    title: decode(item.title).trim(),
    html: item.contentEncoded || item.content || '',
    imageUrl,
  };
}

async function loadArticle() {
  const file = arg('--file');
  if (file && typeof file === 'string') {
    return JSON.parse(await readFile(file, 'utf8'));
  }
  if (process.argv.includes('--rss-latest')) return fromRss({});
  const match = arg('--rss-match');
  if (match && typeof match === 'string') return fromRss({ match });
  throw new Error('Укажи источник: --file <json> | --rss-latest | --rss-match "заголовок"');
}

async function main() {
  if (!config.telegram.botToken) throw new Error('TELEGRAM_BOT_TOKEN не задан в .env');
  const chatId = arg('--chat') || config.telegram.channelId;
  if (!chatId) throw new Error('Не задан канал: --chat @name или TELEGRAM_CHANNEL_ID в .env');
  config.telegram.channelId = chatId;

  const raw = await loadArticle();
  const article = {
    title: (raw.title || '').trim(),
    html: stripInlineImages(raw.html),
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    telegram: raw.telegram || '',
  };
  const image = raw.imageUrl ? { url: raw.imageUrl } : null;

  if (!article.title || !article.html) throw new Error('В статье нет title или html');

  log.info(`Канал: ${chatId}`);
  log.info(`Заголовок: ${article.title}`);
  log.info(`Тело: ${article.html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length} слов; обложка: ${image ? 'да' : 'нет'}`);

  if (process.argv.includes('--dry')) {
    log.ok('DRY — не отправляю. Проверь заголовок/обложку выше.');
    return;
  }
  const r = await postToTelegram(article, image);
  if (r.skipped) log.warn('Пропущено (нет токена/канала).');
  else log.ok(`Опубликовано: message_id ${r.messageId}${r.rich ? ' (Rich с обложкой)' : ' (фолбэк)'}`);
}

main().catch((err) => {
  log.error(err.message);
  process.exit(1);
});
