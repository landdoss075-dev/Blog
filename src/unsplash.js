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

/**
 * Получает несколько фото за один запрос (обложка + иллюстрации в текст).
 * Возвращает массив (может быть короче count или пустым). Первый элемент — обложка.
 */
export async function fetchImages(query, count = 3, fallbackQueries = []) {
  if (!config.unsplash.accessKey) {
    log.warn('UNSPLASH_ACCESS_KEY не задан — публикую без картинок.');
    return [];
  }

  const n = Math.max(1, Math.min(count, 10));
  const queries = [...new Set([query, ...fallbackQueries].map((q) => String(q || '').trim()).filter(Boolean))];
  if (!queries.length) {
    log.warn('Запрос для Unsplash пустой — публикую без картинок.');
    return [];
  }

  for (let i = 0; i < queries.length; i++) {
    const q = queries[i];
    try {
      const list = await fetchImagesOnce(q, n);
      log.ok(`Картинок с Unsplash: ${list.length} по запросу "${q}" (обложка + ${list.length - 1} в текст)`);
      return list;
    } catch (err) {
      const more = i < queries.length - 1 ? ' — пробую запасной запрос.' : '';
      log.warn(`Unsplash не дал фото по запросу "${q}" (${err.message})${more}`);
    }
  }

  log.warn('Не удалось получить фото с Unsplash по основному и запасным запросам — публикую без картинок.');
  return [];
}

async function fetchImagesOnce(query, count) {
  const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(query)}&orientation=landscape&content_filter=high&count=${count}`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${config.unsplash.accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const data = await res.json();
  const list = (Array.isArray(data) ? data : [])
    .map((d) => ({ url: d.urls?.regular, author: d.user?.name, authorUrl: d.user?.links?.html }))
    .filter((x) => x.url);
  if (list.length === 0) throw new Error('пустой ответ');
  return list;
}
