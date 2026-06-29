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
  // Общие слова-«пустышки» — не считаем их ни трендом, ни признаком одной темы при дедупе.
  'новый', 'новая', 'новое', 'новые', 'версия', 'версии', 'способ', 'способы', 'помощь',
  'помощью', 'время', 'работа', 'работе', 'работу', 'сегодня', 'прямо', 'сейчас', 'просто',
  'главное', 'лучшие', 'лучший', 'лучшая', 'быстро', 'нужно', 'можно', 'стало', 'делать',
  'сделать', 'реально', 'теперь', 'самые', 'самый', 'почему', 'зачем', 'будут', 'россии',
]);

/**
 * Чувствительные темы, за которые Дзен снижает/отключает монетизацию
 * (политика, война, трагедии, насилие). Держимся чистых ИИ-инструментов.
 * Матчинг по подстроке в нормализованном (нижний регистр) заголовке.
 */
const SENSITIVE = [
  'политик', 'выборы', 'выборах', 'президент', 'путин', 'кремл', 'госдум', 'депутат', 'министр',
  'санкц', 'пмэф', 'форум', 'саммит', 'переговор',
  'войн', 'военн', 'фронт', 'обстрел', 'ракет', 'дрон', 'бпла', 'мобилизац', 'всу',
  'украин', 'нато', 'оруж', 'взрыв', 'теракт', 'убий', 'насил', 'погиб', 'жертв',
  'ранен', 'смерт', 'катастроф', 'авари', 'пожар', 'наводнен', 'землетряс', 'трагед',
  'протест', 'митинг', 'арест', 'уголовн', 'суд ', 'мигрант', 'религ', 'скандал',
];

function isSensitive(title) {
  const t = title.toLowerCase();
  return SENSITIVE.some((w) => t.includes(w));
}

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
  let droppedSensitive = 0;
  for (const it of items) {
    const title = cleanTitle(it.title);
    if (!title) continue;
    if (isSensitive(title)) { droppedSensitive++; continue; } // безопасно для монетизации Дзена
    const key = normalize(title);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const ts = it.isoDate ? Date.parse(it.isoDate) : NaN;
    all.push({ title, ts: Number.isNaN(ts) ? null : ts });
  }
  if (droppedSensitive) log.info(`Отсеяно чувствительных тем (политика/трагедии): ${droppedSensitive}`);

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

  // Защита от повторов (важно при 3 постах/день и затяжных «флуд-историях» на несколько дней).
  // Дубль = заголовок делит ≥2 значимых слова (или ≥30% по Жаккару) с любой из недавних статей.
  // Этого достаточно, чтобы поймать разные формулировки одной и той же истории.
  const recentTitles = await loadRecentTitles(12);
  const recentKwSets = recentTitles.map((t) => new Set(keywords(t)));
  const isRecentDuplicate = (title) => {
    const kw = keywords(title);
    if (kw.length === 0) return false;
    return recentKwSets.some((set) => {
      let shared = 0;
      for (const s of kw) if (set.has(s)) shared++;
      const union = new Set([...kw, ...set]).size || 1;
      return shared >= 2 || shared / union >= 0.3;
    });
  };
  const top = scored.find((x) => !isRecentDuplicate(x.title)) || scored[0];
  if (top !== scored[0]) log.info('Похожая тема уже выходила недавно — взял другой, свежий повод.');

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

  // Контекст для промпта — заголовки из ТОГО ЖЕ кластера, что и выбранный (а не флуд-история).
  const topKw = new Set(keywords(top.title));
  const sameCluster = scored.filter((x) => keywords(x.title).some((s) => topKw.has(s)));
  const headlines = (sameCluster.length ? sameCluster : scored).slice(0, 6).map((x) => x.title);

  return {
    theme,
    headline: top.title,
    headlines,
    trendKeywords,
    recentTitles, // недавние заголовки — чтобы модель не повторяла их формулировки
  };
}
