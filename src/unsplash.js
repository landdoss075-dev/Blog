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
  if (Array.isArray(query)) {
    return fetchImagesByQueries(query, n, fallbackQueries);
  }

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

async function fetchImagesByQueries(queries, count, fallbackQueries = []) {
  const primary = queries.map((q) => String(q || '').trim()).filter(Boolean);
  const fallback = fallbackQueries.map((q) => String(q || '').trim()).filter(Boolean);
  const slots = [];
  for (let i = 0; i < count; i++) {
    slots.push([...new Set([primary[i], fallback[i], ...fallback].filter(Boolean))]);
  }
  if (!slots.some((list) => list.length)) {
    log.warn('Запросы для Unsplash пустые — публикую без картинок.');
    return [];
  }

  const images = [];
  const usedUrls = new Set();
  const usedAuthors = new Set();
  for (let slot = 0; slot < slots.length; slot++) {
    const image = await fetchDistinctImage(slots[slot], usedUrls, usedAuthors);
    if (!image) continue;
    images.push(image);
    usedUrls.add(normalizeImageUrl(image.url));
    if (image.author) usedAuthors.add(image.author.toLowerCase());
    log.ok(`Картинка ${slot + 1}/${count}: Unsplash по запросу "${image.query}" (автор: ${image.author || 'неизвестен'})`);
  }

  if (images.length) {
    log.ok(`Картинок с Unsplash: ${images.length} по разным запросам (обложка + ${Math.max(0, images.length - 1)} в текст)`);
    return images;
  }

  log.warn('Не удалось получить фото с Unsplash по разным запросам — публикую без картинок.');
  return [];
}

async function fetchDistinctImage(queries, usedUrls, usedAuthors) {
  for (const query of queries) {
    try {
      const candidates = await fetchImagesOnce(query, 4);
      const chosen =
        candidates.find((img) => !usedUrls.has(normalizeImageUrl(img.url)) && !usedAuthors.has(String(img.author || '').toLowerCase())) ||
        candidates.find((img) => !usedUrls.has(normalizeImageUrl(img.url)));
      if (chosen) return { ...chosen, query };
      log.warn(`Unsplash вернул уже использованные фото по запросу "${query}" — пробую другой запрос.`);
    } catch (err) {
      log.warn(`Unsplash не дал фото по запросу "${query}" (${err.message}) — пробую другой запрос.`);
    }
  }
  return null;
}

function normalizeImageUrl(url = '') {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split('?')[0];
  }
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
