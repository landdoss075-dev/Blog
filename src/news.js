import { readFile } from 'node:fs/promises';
import path from 'node:path';
import Parser from 'rss-parser';
import { config } from './config.js';
import { log } from './log.js';

const parser = new Parser({ timeout: 15000 });

/** Заголовки недавно опубликованных статей (для защиты от повторов при 3 постах/день). */
async function loadRecentTitles(limit = 8) {
  try {
    const file = path.resolve(config.site.dir, 'posts.json');
    const posts = JSON.parse(await readFile(file, 'utf8'));
    return posts.slice(0, limit).map((p) => p.title).filter(Boolean);
  } catch {
    return [];
  }
}

// Новости свежее этого порога считаем актуальными.
const FRESH_WINDOW_MS = 48 * 60 * 60 * 1000;

/** Русские + английские стоп-слова, чтобы не считать их «трендом». */
const STOPWORDS = new Set([
  'и', 'в', 'во', 'не', 'что', 'он', 'на', 'я', 'с', 'со', 'как', 'а', 'то', 'все', 'она',
  'так', 'его', 'но', 'да', 'ты', 'к', 'у', 'же', 'вы', 'за', 'бы', 'по', 'только', 'ее',
  'мне', 'было', 'вот', 'от', 'меня', 'еще', 'нет', 'о', 'из', 'ему', 'теперь', 'когда',
  'даже', 'ну', 'вдруг', 'ли', 'если', 'уже', 'или', 'быть', 'был', 'него', 'до', 'вас',
  'для', 'это', 'эта', 'этот', 'эти', 'кто', 'чем', 'был', 'была', 'были', 'будет', 'свой',
  'который', 'которые', 'этом', 'про', 'над', 'под', 'при', 'без', 'чтобы', 'после', 'стал',
  'года', 'году', 'год', 'свои', 'всех', 'всё', 'тоже', 'может', 'нас', 'them', 'the', 'and',
  'for', 'with', 'how', 'new', 'are', 'you', 'your', 'this', 'that', 'из-за', 'млн', 'тыс',
]);

/** URL Google News RSS для поискового запроса (русская локаль). */
function searchUrl(query) {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=ru&gl=RU&ceid=RU:ru`;
}

/** Топовая лента по технологиям (даёт самые заметные новости дня). */
const TOP_TECH_URL =
  'https://news.google.com/rss/headlines/section/topic/TECHNOLOGY?hl=ru&gl=RU&ceid=RU:ru';

/** Чистит заголовок Google News от хвоста « - Источник». */
function cleanTitle(title = '') {
  return title.replace(/\s*-\s*[^-]+$/, '').trim() || title.trim();
}

/** Нормализация для дедупликации. */
function normalize(title) {
  return title.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Слова из наших же поисковых запросов — они есть в КАЖДОЙ ленте,
 * поэтому это шум, а не тренд. Собираем динамически и игнорируем при скоринге.
 */
/** Грубый стем: схлопывает словоформы («интеллекта»→«интелл»), чтобы не считать их разными. */
function stem(word) {
  return word.length >= 7 ? word.slice(0, 6) : word;
}

/**
 * Стемы слов из наших же поисковых запросов — они есть в КАЖДОЙ ленте,
 * поэтому это шум, а не тренд. Игнорируем их при скоринге.
 */
const QUERY_STEMS = new Set(
  config.newsQueries
    .flatMap((q) => q.toLowerCase().replace(/[^a-zа-яё0-9 ]/gi, ' ').split(/\s+/))
    .filter((w) => w.length >= 4)
    .map(stem),
);

/** Значимые слова заголовка (для частотного анализа тренда), в виде стемов. */
function keywords(title) {
  return normalize(title)
    .split(' ')
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w))
    .map(stem)
    .filter((s) => !QUERY_STEMS.has(s));
}

async function fetchFeed(url) {
  try {
    const feed = await parser.parseURL(url);
    return feed.items || [];
  } catch (err) {
    log.warn(`Лента недоступна (${err.message}): ${url.slice(0, 60)}…`);
    return [];
  }
}

/**
 * Собирает новости из всех лент, отбирает свежие, строит частотный
 * «трендоскоп» и возвращает САМЫЙ ГОРЯЧИЙ повод среди свежих новостей.
 *
 * Возвращает: { theme, headline, headlines, trendKeywords }
 */
export async function fetchTopic() {
  log.info('Сбор новостей: поисковые запросы + топ техно-лента…');

  const urls = [...config.newsQueries.map(searchUrl), TOP_TECH_URL];
  const lists = await Promise.all(urls.map(fetchFeed));
  const items = lists.flat();

  // Дедупликация по нормализованному заголовку.
  const seen = new Set();
  const now = Date.now();
  const all = [];
  for (const it of items) {
    const title = cleanTitle(it.title);
    if (!title) continue;
    const key = normalize(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ts = it.isoDate ? Date.parse(it.isoDate) : NaN;
    all.push({ title, ts: Number.isNaN(ts) ? null : ts });
  }

  if (all.length === 0) {
    log.warn('Новостей не получено — использую запасную тему.');
    const theme = config.newsQueries[0];
    return { theme, headline: theme, headlines: [theme], trendKeywords: [] };
  }

  // Свежие новости (≤48ч). Если таких нет — берём все (с неизвестной датой тоже).
  let fresh = all.filter((x) => x.ts !== null && now - x.ts <= FRESH_WINDOW_MS);
  if (fresh.length === 0) fresh = all;

  // Частотный трендоскоп: считаем стемы, попутно запоминая «красивую» полную словоформу.
  const freq = new Map();        // стем -> сколько заголовков его содержат
  const display = new Map();     // стем -> {word, count} самая частая полная форма
  for (const item of fresh) {
    const seenStems = new Set();
    for (const w of normalize(item.title).split(' ')) {
      if (w.length < 4 || STOPWORDS.has(w)) continue;
      const s = stem(w);
      if (QUERY_STEMS.has(s)) continue;
      // Полная форма для показа — выбираем самую частую среди вариантов стема.
      const cur = display.get(s);
      const wc = (cur?.forms?.get(w) || 0) + 1;
      const forms = cur?.forms || new Map();
      forms.set(w, wc);
      const best = [...forms.entries()].sort((a, b) => b[1] - a[1])[0][0];
      display.set(s, { word: best, forms });
      // Частоту по заголовку считаем один раз на стем.
      if (!seenStems.has(s)) {
        seenStems.add(s);
        freq.set(s, (freq.get(s) || 0) + 1);
      }
    }
  }

  // Скоринг заголовка = сумма частот его ключевых слов (+ лёгкий бонус за свежесть).
  const scored = fresh.map((item) => {
    const kws = keywords(item.title);
    const trendScore = kws.reduce((s, w) => s + (freq.get(w) || 0), 0);
    const ageHours = item.ts ? (now - item.ts) / 3.6e6 : 24;
    const freshBonus = Math.max(0, (FRESH_WINDOW_MS / 3.6e6 - ageHours) / 48); // 0..1
    return { ...item, score: trendScore + freshBonus };
  });
  scored.sort((a, b) => b.score - a.score);

  // Защита от повторов (важно при 3 постах/день, чтобы не плодить дубли одной темы).
  const recentTitles = await loadRecentTitles(8);
  const recentStemSets = recentTitles.map((t) => new Set(keywords(t)));
  const recentStemsAll = new Set(recentTitles.flatMap((t) => keywords(t)));
  // «Мега-событие дня» — самый частый тренд-стем. Если день им «захвачен» (≥3 заголовков)
  // и мы о нём уже писали, берём повод из другого кластера, а не другой заголовок про то же.
  const topStem = [...freq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const floodCovered = topStem && (freq.get(topStem) || 0) >= 3 && recentStemsAll.has(topStem);

  const isRecentDuplicate = (title) => {
    const kw = keywords(title);
    if (kw.length === 0) return false;
    // 1) почти тот же заголовок (сильное пересечение слов)
    const near = recentStemSets.some(
      (set) => kw.filter((s) => set.has(s)).length / kw.length >= 0.5,
    );
    // 2) повод из «захватившего день» мега-события, о котором уже писали
    const flood = floodCovered && kw.includes(topStem);
    return near || flood;
  };
  const top = scored.find((x) => !isRecentDuplicate(x.title)) || scored[0];
  if (top !== scored[0]) log.info('Тема уже освещена недавно — беру повод из другого кластера.');

  const trendKeywords = [...freq.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([s]) => display.get(s)?.word || s);

  log.ok(`Горячий повод (счёт ${top.score.toFixed(1)}): «${top.title}»`);
  if (trendKeywords.length) log.info(`Тренды дня: ${trendKeywords.join(', ')}`);

  // Тема — по словам ВЫБРАННОГО заголовка (а не глобальных трендов), чтобы не путать промпт.
  const topWords = [...new Set(keywords(top.title).map((s) => display.get(s)?.word || s))];
  const theme = topWords.slice(0, 4).join(', ') || trendKeywords.slice(0, 3).join(', ') || config.newsQueries[0];

  return {
    theme,
    headline: top.title,
    headlines: scored.slice(0, 6).map((x) => x.title),
    trendKeywords,
  };
}
