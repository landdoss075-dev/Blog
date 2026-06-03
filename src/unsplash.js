import { config } from './config.js';
import { log } from './log.js';

/**
 * Ищет тематическое фото на Unsplash по ключевым словам.
 * Если ключа нет или поиск не дал результата — возвращает null,
 * и пайплайн опубликует пост без картинки.
 */
export async function fetchImage(query) {
  if (!config.unsplash.accessKey) {
    log.warn('UNSPLASH_ACCESS_KEY не задан — публикую без картинки.');
    return null;
  }

  const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${config.unsplash.accessKey}` },
    });
    if (!res.ok) {
      throw new Error(`Unsplash ${res.status}`);
    }
    const data = await res.json();
    const image = {
      url: data.urls?.regular,
      author: data.user?.name,
      authorUrl: data.user?.links?.html,
    };
    if (!image.url) throw new Error('нет url в ответе');

    log.ok(`Картинка с Unsplash (автор: ${image.author || 'неизвестен'})`);
    return image;
  } catch (err) {
    log.warn(`Не удалось получить фото с Unsplash (${err.message}) — публикую без картинки.`);
    return null;
  }
}
