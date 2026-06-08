import { config } from './config.js';
import { log } from './log.js';
import { toPlainText } from './sanitize.js';
import { slugify, insertInlineImages } from './site.js';

/**
 * Публикация статьи на сайт atmoapp.ru через защищённый ingest-эндпоинт бэкенда.
 * Бэкенд сам ограничивает «1 статья в день» и дедуплицирует по slug —
 * поэтому можно слать на каждом запуске, лишнее он отклонит.
 *
 * Если ATMO_API_URL/секрет не заданы — мягко пропускаем (как другие площадки).
 */
export async function postToAtmoapp(article, image, inlineImages = []) {
  if (!config.atmoapp.apiUrl || !config.atmoapp.secret) {
    log.warn('ATMO_API_URL/секрет не заданы — пропускаю публикацию на atmoapp.ru.');
    return { skipped: true };
  }

  const date = new Date().toISOString();
  const slug = slugify(article.title, date);
  const content = insertInlineImages(article.html, inlineImages);
  const metaDescription = toPlainText(article.html).slice(0, 160);

  const res = await fetch(`${config.atmoapp.apiUrl.replace(/\/+$/, '')}/blog/ingest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-ingest-secret': config.atmoapp.secret,
    },
    body: JSON.stringify({
      slug,
      title: article.title,
      content,
      metaTitle: article.title,
      metaDescription,
      imageUrl: image?.url,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`atmoapp ingest ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json().catch(() => ({}));
  if (data.skipped) {
    log.info(`atmoapp.ru пропустил (${data.reason || 'duplicate'}).`);
    return { skipped: true, reason: data.reason };
  }
  log.ok(`Опубликовано на atmoapp.ru: /blog/${data.slug || slug}`);
  return { skipped: false, slug: data.slug || slug };
}
