import { config } from './config.js';
import { log } from './log.js';

const NO_TEXT_QUERY_SUFFIX = 'no text no logo no sign';
const TEXT_RISK_METADATA = [
  'text',
  'word',
  'letter',
  'letters',
  'sign',
  'signage',
  'poster',
  'billboard',
  'logo',
  'label',
  'packaging',
  'screen',
  'monitor',
  'display',
  'interface',
  'website',
  'webpage',
  'browser',
  'newspaper',
  'magazine',
  'book',
  'receipt',
  'bill',
  'invoice',
  'document',
  'paperwork',
  'keyboard',
  'storefront',
  'street sign',
];

const QUERY_TEXT_RISK_TERMS = new Set([
  'screen',
  'browser',
  'search',
  'chat',
  'app',
  'interface',
  'website',
  'webpage',
  'document',
  'documents',
  'receipt',
  'receipts',
  'bill',
  'bills',
  'invoice',
  'notebook',
  'notes',
  'paperwork',
  'paper',
  'book',
  'newspaper',
  'magazine',
  'poster',
  'sign',
  'logo',
  'label',
  'labels',
  'packaging',
  'text',
  'words',
  'letters',
  'keyboard',
  'storefront',
]);

function sanitizeQueryBase(query) {
  const raw = String(query || '').trim().toLowerCase();
  const words = raw.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
  const cleaned = words.filter((w) => !QUERY_TEXT_RISK_TERMS.has(w)).join(' ').replace(/\s+/g, ' ').trim();
  if (cleaned.split(/\s+/).filter(Boolean).length >= 2) return cleaned.slice(0, 80);

  if (/\b(phone|smartphone|mobile)\b/.test(raw)) return 'hands holding phone';
  if (/\b(laptop|computer|pc)\b/.test(raw)) return 'closed laptop desk';
  if (/\b(tablet)\b/.test(raw)) return 'tablet on desk';
  if (/\b(document|receipt|bill|paper|notebook|book|newspaper|magazine)\b/.test(raw)) return 'home office desk';
  if (/\b(card|bank|money|budget|finance|coins)\b/.test(raw)) return 'coins wallet table';
  if (/\b(garden|tomato|cucumber|seedling|plant)\b/.test(raw)) return 'garden plants closeup';
  if (/\b(cat|dog|pet)\b/.test(raw)) return 'pet sleeping home';
  if (/\b(family|parent|child|couple)\b/.test(raw)) return 'family dinner table';
  return 'hands table home';
}

function prepareQuery(query) {
  const base = sanitizeQueryBase(query);
  if (!base) return '';
  return `${base} ${NO_TEXT_QUERY_SUFFIX}`;
}

function hasTextRiskMetadata(photo) {
  const text = [
    photo.alt_description,
    photo.description,
    photo.location?.name,
    ...(photo.tags || []).map((tag) => tag.title),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return TEXT_RISK_METADATA.some((term) => text.includes(term));
}

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

  const safeQuery = prepareQuery(query);
  const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(safeQuery)}&orientation=landscape&content_filter=high`;

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Client-ID ${config.unsplash.accessKey}` },
    });
    if (!res.ok) {
      throw new Error(`Unsplash ${res.status}`);
    }
    const data = await res.json();
    if (hasTextRiskMetadata(data)) {
      throw new Error('фото похоже на изображение с текстом/вывеской/экраном');
    }
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
    const safeQuery = sanitizeQueryBase(q);
    try {
      const list = await fetchImagesOnce(q, n);
      log.ok(`Картинок с Unsplash: ${list.length} по запросу "${safeQuery}" (обложка + ${list.length - 1} в текст)`);
      return list;
    } catch (err) {
      const more = i < queries.length - 1 ? ' — пробую запасной запрос.' : '';
      log.warn(`Unsplash не дал фото по запросу "${safeQuery}" (${err.message})${more}`);
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
  const usedQueries = new Set();
  for (let slot = 0; slot < slots.length; slot++) {
    const image = await fetchDistinctImage(slots[slot], usedUrls, usedAuthors, usedQueries);
    if (!image) continue;
    images.push(image);
    usedUrls.add(normalizeImageUrl(image.url));
    if (image.author) usedAuthors.add(image.author.toLowerCase());
    usedQueries.add(image.query);
    log.ok(`Картинка ${slot + 1}/${count}: Unsplash по запросу "${image.query}" (автор: ${image.author || 'неизвестен'})`);
  }

  if (images.length) {
    log.ok(`Картинок с Unsplash: ${images.length} по разным запросам (обложка + ${Math.max(0, images.length - 1)} в текст)`);
    return images;
  }

  log.warn('Не удалось получить фото с Unsplash по разным запросам — публикую без картинок.');
  return [];
}

async function fetchDistinctImage(queries, usedUrls, usedAuthors, usedQueries = new Set()) {
  for (const query of queries) {
    const safeQuery = sanitizeQueryBase(query);
    if (usedQueries.has(safeQuery)) continue;
    try {
      const candidates = await fetchImagesOnce(query, 4);
      const chosen =
        candidates.find((img) => !usedUrls.has(normalizeImageUrl(img.url)) && !usedAuthors.has(String(img.author || '').toLowerCase())) ||
        candidates.find((img) => !usedUrls.has(normalizeImageUrl(img.url)));
      if (chosen) return { ...chosen, query: safeQuery };
      log.warn(`Unsplash вернул уже использованные фото по запросу "${safeQuery}" — пробую другой запрос.`);
    } catch (err) {
      log.warn(`Unsplash не дал фото по запросу "${safeQuery}" (${err.message}) — пробую другой запрос.`);
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
  const safeQuery = prepareQuery(query);
  const requestCount = Math.max(count, 8);
  const url = `https://api.unsplash.com/photos/random?query=${encodeURIComponent(safeQuery)}&orientation=landscape&content_filter=high&count=${requestCount}`;
  const res = await fetch(url, {
    headers: { Authorization: `Client-ID ${config.unsplash.accessKey}` },
  });
  if (!res.ok) throw new Error(`Unsplash ${res.status}`);
  const data = await res.json();
  const safePhotos = (Array.isArray(data) ? data : []).filter((d) => !hasTextRiskMetadata(d));
  const list = safePhotos
    .map((d) => ({ url: d.urls?.regular, author: d.user?.name, authorUrl: d.user?.links?.html }))
    .filter((x) => x.url);
  if (list.length === 0) throw new Error('нет фото без признаков видимого текста');
  return list.slice(0, count);
}
