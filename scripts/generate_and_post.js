import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config, assertRequired } from '../src/config.js';
import { log } from '../src/log.js';
import { fetchTopic } from '../src/news.js';
import { generateArticle } from '../src/llm.js';
import { fetchImages } from '../src/unsplash.js';
import { postToTelegram } from '../src/telegram.js';
import { publishToSite } from '../src/site.js';

/**
 * Пайплайн ежедневной публикации:
 *   тема (Google News) → статья (OpenRouter/Groq) → картинка (Unsplash)
 *   → Telegram (Bot API) + сайт GitHub Pages/RSS (→ импорт в Яндекс Дзен).
 *
 * Запуск:  node scripts/generate_and_post.js [--dry-run]
 */
async function main() {
  log.step(`AI Blog Autoposter${config.dryRun ? ' — DRY RUN (без публикации)' : ''}`);
  assertRequired();

  // 1. Тема дня
  log.step('1/5 Поиск темы (Google News RSS)');
  const topic = await fetchTopic();

  // 2. Генерация статьи
  log.step(`2/5 Генерация статьи (${config.provider})`);
  const article = await generateArticle(topic);

  // 3. Картинки (обложка + иллюстрации в текст)
  log.step('3/5 Подбор картинок (Unsplash)');
  const images = await fetchImages(article.image_query, 3);
  const image = images[0] || null;          // обложка
  const inlineImages = images.slice(1);      // в текст статьи (для сайта/Дзена)

  // Dry-run: сохраняем результат в out/ и выходим
  if (config.dryRun) {
    await saveDryRun({ topic, article, image, inlineImages });
    log.ok('DRY RUN завершён — ничего не опубликовано.');
    return;
  }

  // 4. Telegram (обложка + текст)
  log.step('4/5 Публикация в Telegram');
  const tg = await safe('Telegram', () => postToTelegram(article, image));

  // 5. Сайт + RSS (источник для импорта в Яндекс Дзен)
  log.step('5/5 Обновление сайта/RSS (для Дзена)');
  const site = await safe('Site', () => publishToSite(article, image, inlineImages));

  log.step('Итог');
  summarize({ tg, site });
}

/** Выполняет публикацию, не роняя весь процесс из-за одной площадки. */
async function safe(name, fn) {
  try {
    return await fn();
  } catch (err) {
    log.error(`${name}: ${err.message}`);
    return { error: err.message };
  }
}

function summarize({ tg, site }) {
  const status = (r) => (r?.error ? `ошибка (${r.error})` : r?.skipped ? 'пропущено' : 'опубликовано');
  log.info(`Telegram: ${status(tg)}`);
  log.info(`Сайт/RSS (Дзен): ${status(site)}`);

  // Если ни одна площадка не опубликовала — это провал запуска.
  const published = [tg, site].some((r) => r && !r.skipped && !r.error);
  if (!published) {
    throw new Error('Ни одна площадка не опубликовала пост.');
  }
  log.ok('Готово.');
}

async function saveDryRun(result) {
  const dir = path.resolve('out');
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  await writeFile(path.join(dir, `article-${ts}.json`), JSON.stringify(result, null, 2), 'utf8');

  const preview = `<!doctype html><meta charset="utf-8">
<title>${result.article.title}</title>
<body style="max-width:680px;margin:40px auto;font:18px/1.6 system-ui;padding:0 16px">
<h1>${result.article.title}</h1>
${result.image?.url ? `<img src="${result.image.url}" style="width:100%;border-radius:12px">` : ''}
${result.article.html}
<hr><h3>Версия для Telegram</h3><pre style="white-space:pre-wrap">${result.article.telegram}</pre>
</body>`;
  await writeFile(path.join(dir, `preview-${ts}.html`), preview, 'utf8');

  log.ok(`Результат сохранён в out/ (article-${ts}.json + preview-${ts}.html)`);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
