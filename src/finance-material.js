import { toPlainText } from './sanitize.js';
import { scoreFinanceReaderValue } from './finance-reader.js';
import { log } from './log.js';

// Only these official indexes are fetched. Neither model URLs nor Google redirects
// are followed. A changed layout/timeout means no candidate, not weaker evidence.
export const FINANCE_MATERIAL_INDEXES = [
  'https://sfr.gov.ru/press_center/news/',
  'https://www.nalog.gov.ru/rn77/news/activities_fts/',
];
const WINDOW_MS = 7 * 86400000;
const MAX_HTML_BYTES = 1500000;
const normalize = value => toPlainText(String(value || '')).toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const tokens = value => new Set(normalize(value).split(' ').filter(word => word.length >= 6).map(word => word.slice(0, 6)));

export function isFinanceMaterialUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.search && !url.hash
      && ((url.hostname === 'sfr.gov.ru' && /^\/press_center\/news\/~\d{4}\/\d{2}\/\d{2}\/\d+\/?$/.test(url.pathname))
        || (url.hostname === 'www.nalog.gov.ru' && /^\/rn77\/news\/activities_fts\/\d+\/$/.test(url.pathname)));
  } catch { return false; }
}

function attribute(tag, name) {
  return tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*["']([^"']*)["']`, 'i'))?.[1] || '';
}

// Extract a known div including nested divs; never fall back to the whole site's
// navigation/footer as "source text" if the expected article container disappears.
function contentDiv(html, marker) {
  const opening = [...html.matchAll(/<div\b[^>]*>/gi)].find(match => marker(match[0]));
  if (!opening) return '';
  const start = opening.index + opening[0].length;
  const tags = /<\/?div\b[^>]*>/gi;
  tags.lastIndex = start;
  let depth = 1;
  for (let match; (match = tags.exec(html));) {
    depth += /^<\//.test(match[0]) ? -1 : 1;
    if (!depth) return html.slice(start, match.index);
  }
  return '';
}

export function parseFinanceMaterialIndex(html, indexUrl) {
  if (!FINANCE_MATERIAL_INDEXES.includes(indexUrl)) return [];
  const candidates = new Map();
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let url;
    try { url = new URL(attribute(match[1], 'href'), indexUrl).href; } catch { continue; }
    const title = toPlainText(match[2]).replace(/\s+/g, ' ').trim();
    if (!isFinanceMaterialUrl(url) || title.length < 20 || title.length > 250) continue;
    candidates.set(url, { url, title });
  }
  return [...candidates.values()];
}

function articleDate(html, url) {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    if (attribute(match[0], 'itemprop') === 'datePublished' || attribute(match[0], 'property') === 'article:published_time') {
      const ts = Date.parse(attribute(match[0], 'content'));
      if (Number.isFinite(ts)) return ts;
    }
  }
  const date = url.match(/~(\d{4})\/(\d{2})\/(\d{2})\//);
  if (date) return Date.parse(`${date[1]}-${date[2]}-${date[3]}T00:00:00+03:00`);
  const visible = html.match(/Дата публикации:\s*(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}:\d{2})/i);
  return visible ? Date.parse(`${visible[3]}-${visible[2]}-${visible[1]}T${visible[4]}:00+03:00`) : NaN;
}

export function parseFinanceMaterial(html, candidate, now = new Date()) {
  if (!isFinanceMaterialUrl(candidate.url)) return null;
  const published = articleDate(html, candidate.url);
  if (!Number.isFinite(published) || published > now.getTime() || now.getTime() - published > WINDOW_MS) return null;
  const body = contentDiv(html, tag => attribute(tag, 'itemprop') === 'articleBody')
    || contentDiv(html, tag => attribute(tag, 'class').split(/\s+/).includes('text_block'));
  const cleaned = body.replace(/<(script|style|nav|header|footer)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    // FNS includes an archived-publication warning even in a hidden div.
    .replace(/<div\b[^>]*class=["'][^"']*attention[^"']*["'][^>]*>[\s\S]*?<\/div>\s*<\/div>/gi, '');
  const text = toPlainText(cleaned).replace(/\s+/g, ' ').trim();
  if (text.length < 600 || text.length > 9000 || /captcha|проверка браузера|доступ ограничен/i.test(text)) return null;
  const title = toPlainText(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '').trim();
  // A different page/error document must not inherit the index's headline/date.
  if (!title || normalize(title) !== normalize(candidate.title)) return null;
  if (!/услов|если|право|размер|назнач|начисл|документ|срок|заявлен|расч[её]т|уплат/iu.test(text)) return null;
  return { label: title, url: candidate.url, text, publishedAt: new Date(published).toISOString(), checkedAt: now.toISOString(), kind: 'official-material' };
}

export function isRepeatedFinanceMaterial(candidate, recentPosts, now = new Date()) {
  const words = tokens(candidate.title);
  return recentPosts.some(post => {
    if ([post.source?.sourceUrl, post.source?.materialSelection?.primaryUrl, ...(post.source?.references || []).map(ref => ref.url)].includes(candidate.url)) return true;
    if (/капремонт/i.test(candidate.title) && /капремонт/i.test(`${post.title} ${post.source?.headline}`)
      && now.getTime() - Date.parse(post.date) < 7 * 86400000) return true;
    const previous = tokens(`${post.title || ''} ${post.source?.headline || ''}`);
    const shared = [...words].filter(word => previous.has(word)).length;
    const union = new Set([...words, ...previous]).size;
    return shared >= 3 || (shared >= 2 && shared / Math.max(1, union) >= 0.28);
  });
}

async function readHtml(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok || (response.headers?.get('content-length') && Number(response.headers.get('content-length')) > MAX_HTML_BYTES)) throw new Error('Недоступный или слишком большой официальный материал');
  // Stream with a bound instead of buffering an untrusted response without limit.
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text) > MAX_HTML_BYTES) throw new Error('Слишком большой ответ');
    return text;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_HTML_BYTES) throw new Error('Слишком большой ответ');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  return Buffer.concat(chunks).toString('utf8');
}

export async function discoverFinanceMaterial(niche, { recentPosts = [], now = new Date(), fetchImpl = fetch } = {}) {
  const lists = await Promise.all(FINANCE_MATERIAL_INDEXES.map(async index => {
    try { return parseFinanceMaterialIndex(await readHtml(index, fetchImpl), index); }
    catch { log.warn(`Официальный раздел недоступен: ${index}`); return []; }
  }));
  const seen = new Set();
  const candidates = lists.flat().filter(candidate => {
    if (seen.has(candidate.url)) return false;
    seen.add(candidate.url);
    const title = candidate.title.toLowerCase();
    if ((niche.blockedSourceTerms || []).some(term => title.includes(term.toLowerCase()))) return false;
    // Institutional reports and business-only tax news are not household material.
    if (/совещан|соглашени|подв[её]л.{0,15}итог|марафон|вебинар|семинар|конференц|медработник|бойц|военнослуж|организаци|контракт|предпринимател|ндс|страхов.{0,12}взнос/iu.test(title)) return false;
    candidate.readerValue = scoreFinanceReaderValue(candidate.title);
    // "Проект бюджета Соцфонда" contains money words too, but does not yet
    // promise a concrete household answer. Do not promote it just for being official.
    const readerQuestion = candidate.readerValue.parts.question >= 3 || candidate.readerValue.parts.usefulAction >= 3;
    return candidate.readerValue.total >= 10 && readerQuestion && !isRepeatedFinanceMaterial(candidate, recentPosts, now);
  }).sort((a, b) => b.readerValue.total - a.readerValue.total);
  // At most four article reads, in parallel. No paid ranking call or retry loop.
  const read = await Promise.all(candidates.slice(0, 4).map(async candidate => {
    try {
      const source = parseFinanceMaterial(await readHtml(candidate.url, fetchImpl), candidate, now);
      return source ? { ...candidate, source } : null;
    } catch { return null; }
  }));
  const group = title => /наслед|нотариус/iu.test(title) ? 'inheritance' : /вычет|ндфл|налог/iu.test(title) ? 'tax' : /пособи|материнск|семь/iu.test(title) ? 'family' : /жкх|жку|квитанц|отоплен|капремонт/iu.test(title) ? 'housing' : 'pension';
  const usage = key => recentPosts.slice(0, 14).filter(post => post.source?.topicGroup === key).length;
  const ranked = read.filter(Boolean).map(candidate => {
    const topicGroup = group(candidate.title);
    const consecutive = recentPosts.slice(0, 2).filter(post => post.source?.topicGroup === topicGroup).length;
    return { ...candidate, topicGroup, priority: candidate.readerValue.total - usage(topicGroup) - consecutive * 5 };
  }).filter(candidate => !(recentPosts.length >= 2 && recentPosts.slice(0, 2).every(post => post.source?.topicGroup === candidate.topicGroup)))
    .sort((a, b) => b.priority - a.priority || b.source.publishedAt.localeCompare(a.source.publishedAt));
  if (!ranked.length) return null;
  const selected = ranked[0];
  log.info(`Отбор по прочитанным официальным материалам: ${JSON.stringify(ranked.map(item => ({ question: item.title, url: item.url, readerValue: item.readerValue.total, priority: item.priority })))}`);
  return {
    theme: selected.title, headline: selected.title, headlines: [selected.title],
    topicOrigin: 'news', topicScore: null, topicGroup: selected.topicGroup, sourceUrl: selected.url,
    primaryMaterial: selected.source,
    materialSelection: { version: 1, basis: 'read-official-material', primaryUrl: selected.url, publishedAt: selected.source.publishedAt,
      readerValue: selected.readerValue, shortlist: ranked.map(item => ({ url: item.url, question: item.title, readerValue: item.readerValue.total })) },
    selectionReason: 'read-official-material', currentDate: now.toISOString().slice(0, 10),
  };
}
