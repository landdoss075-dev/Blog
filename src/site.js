import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { log } from './log.js';
import { toPlainText } from './sanitize.js';

/**
 * Генерация статического сайта (GitHub Pages) и RSS-ленты для Яндекс Дзена.
 * Дзен импортирует статьи именно из RSS — прямого API публикации у него нет.
 *
 * Структура каталога site.dir (по умолчанию docs/):
 *   posts.json        — хранилище опубликованных статей (новые сверху)
 *   posts/<slug>.html — страница статьи
 *   index.html        — список статей
 *   rss.xml           — лента для Дзена
 */

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};

export function slugify(title, date) {
  const translit = title
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join('');
  const base = translit
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const day = date.slice(0, 10);
  return `${day}-${base || 'post'}`;
}

function xmlEscape(s = '') {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Оборачивает HTML в CDATA, обезвреживая последовательность ]]>. */
function cdata(html) {
  return `<![CDATA[${String(html).replace(/]]>/g, ']]]]><![CDATA[>')}]]>`;
}

/**
 * Равномерно вставляет иллюстрации между абзацами статьи
 * (дольше читают/скроллят → больше минут чтения, что важно для монетизации Дзена).
 * URL берётся «сырым»: в CDATA RSS символ & допустим, браузеры в src его тоже терпят.
 */
export function insertInlineImages(html, images = []) {
  if (!images.length) return html;
  const parts = html.split('</p>');
  if (parts.length < 3) return html; // слишком короткая статья — не дробим
  const slots = images.length;
  for (let i = 0; i < slots; i++) {
    const pos = Math.min(Math.max(Math.floor((parts.length * (i + 1)) / (slots + 1)), 1), parts.length - 1);
    parts[pos] = `<p><img src="${images[i].url}" alt=""></p>` + parts[pos];
  }
  return parts.join('</p>');
}

async function loadPosts(dir) {
  try {
    return JSON.parse(await readFile(path.resolve(dir, 'posts.json'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * Добавляет статью на сайт: создаёт страницу, обновляет хранилище,
 * перестраивает index.html, rss.xml, sitemap.xml, robots.txt, страницу автора.
 * `site` — резолвленный объект ниши: { title, description, url, author, dir, maxPosts }.
 *
 * Если site.url не задан — мягко пропускает (как и другие площадки).
 */
export async function publishToSite(article, image, inlineImages = [], site) {
  if (!site?.url) {
    log.warn('URL сайта ниши не задан — пропускаю генерацию сайта/RSS для Дзена.');
    return { skipped: true };
  }

  const date = new Date().toISOString();
  const slug = slugify(article.title, date);
  const url = `${site.url}/posts/${slug}.html`;

  const post = {
    slug,
    title: article.title,
    html: insertInlineImages(article.html, inlineImages),
    excerpt: toPlainText(article.html).slice(0, 220),
    tags: article.tags || [],
    image: image?.url ? { url: image.url, author: image.author || '' } : null,
    date,
    url,
  };

  // Обновляем хранилище: новая статья сверху, без дублей по slug, обрезаем до maxPosts.
  let posts = await loadPosts(site.dir);
  posts = posts.filter((p) => p.slug !== slug);
  posts.unshift(post);
  posts = posts.slice(0, site.maxPosts);

  await writeSiteFiles(posts, site);

  log.ok(`Сайт обновлён: ${url} (всего статей в ленте: ${posts.length})`);
  return { skipped: false, url, slug, total: posts.length };
}

/** Пересобирает сайт/RSS из готового массива posts, не меняя даты/slug существующих статей. */
export async function rebuildSite(posts, site) {
  if (!site?.url) {
    log.warn('URL сайта ниши не задан — пропускаю пересборку сайта/RSS.');
    return { skipped: true };
  }
  await writeSiteFiles(posts, site);
  log.ok(`Сайт пересобран: ${site.url} (всего статей в ленте: ${posts.length})`);
  return { skipped: false, total: posts.length };
}

async function writeSiteFiles(posts, site) {
  const dir = path.resolve(site.dir);
  await mkdir(path.join(dir, 'posts'), { recursive: true });
  await writeFile(path.join(dir, 'posts.json'), JSON.stringify(posts, null, 2), 'utf8');
  for (const post of posts) {
    await writeFile(path.join(dir, 'posts', `${post.slug}.html`), renderPostPage(post, site), 'utf8');
  }
  await writeFile(path.join(dir, 'index.html'), renderIndex(posts, site), 'utf8');
  await writeFile(path.join(dir, 'rss.xml'), renderRss(posts, site), 'utf8');
  await writeFile(path.join(dir, 'sitemap.xml'), renderSitemap(posts, site), 'utf8');
  await writeFile(path.join(dir, 'robots.txt'), renderRobots(site), 'utf8');
  await writeFile(path.join(dir, 'about.html'), renderAbout(site), 'utf8');
  // .nojekyll — чтобы GitHub Pages не пытался обрабатывать сайт через Jekyll.
  await writeFile(path.join(dir, '.nojekyll'), '', 'utf8');
}

const PAGE_CSS =
  'max-width:720px;margin:0 auto;padding:24px 16px;font:18px/1.7 -apple-system,Segoe UI,Roboto,sans-serif;color:#1a1a1a';

function ruDate(d) {
  return new Date(d).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

/** Имя автора (author в нише — объект {name,bio} или строка). */
function authorName(site) {
  return typeof site.author === 'object' ? site.author.name : site.author || 'Редакция';
}

/** Блок автора под статьёй (E-E-A-T: имя + био со ссылкой на страницу автора). */
function authorBlock(site) {
  const name = authorName(site);
  const bio = typeof site.author === 'object' ? site.author.bio : '';
  if (!name) return '';
  return `<div style="margin:32px 0 8px;padding:16px;border-top:1px solid #eee;color:#444;font-size:15px">
  <b>${xmlEscape(name)}</b>${bio ? ` — ${xmlEscape(bio)}` : ''}
  <br><a href="../about.html" style="color:#0a66c2;text-decoration:none">Об авторе →</a>
</div>`;
}

/** Schema.org Article (JSON-LD) — поисковик видит тип, автора, дату. */
function articleJsonLd(post, site) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: post.title,
    description: post.excerpt,
    datePublished: post.date,
    author: { '@type': 'Person', name: authorName(site) },
    publisher: { '@type': 'Organization', name: site.title },
    ...(post.image ? { image: post.image.url } : {}),
    mainEntityOfPage: post.url,
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function renderPostPage(post, site) {
  const img = post.image
    ? `<img src="${xmlEscape(post.image.url)}" alt="" style="width:100%;border-radius:12px;margin:16px 0">`
    : '';
  const tags = post.tags.length
    ? `<p style="color:#888;font-size:15px">${post.tags.map((t) => '#' + xmlEscape(t)).join(' ')}</p>`
    : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(post.title)}</title>
<meta name="description" content="${xmlEscape(post.excerpt)}">
<link rel="canonical" href="${xmlEscape(post.url)}">
<meta property="og:type" content="article">
<meta property="og:title" content="${xmlEscape(post.title)}">
<meta property="og:description" content="${xmlEscape(post.excerpt)}">
${post.image ? `<meta property="og:image" content="${xmlEscape(post.image.url)}">` : ''}
<link rel="alternate" type="application/rss+xml" href="../rss.xml">
${articleJsonLd(post, site)}
</head>
<body style="${PAGE_CSS}">
<p><a href="../index.html" style="color:#0a66c2;text-decoration:none">← Все статьи</a></p>
<h1>${xmlEscape(post.title)}</h1>
<p style="color:#888;font-size:15px">${authorName(site)} · ${ruDate(post.date)}</p>
${img}
${post.html}
${tags}
${authorBlock(site)}
</body>
</html>`;
}

function renderIndex(posts, site) {
  const items = posts
    .map(
      (p) => `<article style="border-bottom:1px solid #eee;padding:18px 0">
  <h2 style="margin:0 0 6px"><a href="posts/${p.slug}.html" style="color:#1a1a1a;text-decoration:none">${xmlEscape(p.title)}</a></h2>
  <p style="color:#888;font-size:14px;margin:0 0 8px">${ruDate(p.date)}</p>
  <p style="margin:0;color:#444">${xmlEscape(p.excerpt)}…</p>
</article>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${xmlEscape(site.title)}</title>
<meta name="description" content="${xmlEscape(site.description)}">
<link rel="canonical" href="${xmlEscape(site.url)}/">
<link rel="alternate" type="application/rss+xml" title="RSS" href="rss.xml">
</head>
<body style="${PAGE_CSS}">
<h1>${xmlEscape(site.title)}</h1>
<p style="color:#666">${xmlEscape(site.description)}</p>
<p style="font-size:15px"><a href="about.html" style="color:#0a66c2;text-decoration:none">Об авторе</a></p>
${items || '<p>Скоро здесь появятся статьи.</p>'}
</body>
</html>`;
}

/** Страница «Об авторе» — ключевой E-E-A-T сигнал (без неё материал не получает экспертный кредит). */
function renderAbout(site) {
  const name = authorName(site);
  const bio = typeof site.author === 'object' ? site.author.bio : '';
  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Об авторе — ${xmlEscape(site.title)}</title>
<meta name="description" content="${xmlEscape(name)}: ${xmlEscape(bio).slice(0, 150)}">
<link rel="canonical" href="${xmlEscape(site.url)}/about.html">
</head>
<body style="${PAGE_CSS}">
<p><a href="index.html" style="color:#0a66c2;text-decoration:none">← Все статьи</a></p>
<h1>Об авторе</h1>
<h2 style="margin-bottom:4px">${xmlEscape(name)}</h2>
<p style="color:#444">${xmlEscape(bio)}</p>
<p style="color:#666;font-size:15px">${xmlEscape(site.description)}</p>
</body>
</html>`;
}

/** sitemap.xml — главная, страница автора, все статьи. */
function renderSitemap(posts, site) {
  const urls = [
    `${site.url}/`,
    `${site.url}/about.html`,
    ...posts.map((p) => p.url),
  ];
  const body = urls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}

function renderRobots(site) {
  return `User-agent: *\nAllow: /\nSitemap: ${site.url}/sitemap.xml\n`;
}

/** RSS-лента по требованиям Яндекс Дзена (namespace yandex/media, content:encoded, enclosure). */
function renderRss(posts, site) {
  const items = posts
    .map((p) => {
      const enclosure = p.image
        ? `\n      <enclosure url="${xmlEscape(p.image.url)}" type="image/jpeg" length="0"/>` +
          `\n      <media:content url="${xmlEscape(p.image.url)}" medium="image"/>`
        : '';
      const cats = p.tags.map((t) => `\n      <category>${xmlEscape(t)}</category>`).join('');
      return `    <item>
      <title>${xmlEscape(p.title.slice(0, 200))}</title>
      <link>${xmlEscape(p.url)}</link>
      <guid isPermaLink="true">${xmlEscape(p.url)}</guid>
      <pubDate>${new Date(p.date).toUTCString()}</pubDate>
      <description>${xmlEscape(p.excerpt)}</description>
      <content:encoded>${cdata(p.html)}</content:encoded>
      <yandex:full-text>${cdata(toPlainText(p.html))}</yandex:full-text>${enclosure}${cats}
    </item>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:yandex="http://news.yandex.ru" xmlns:media="http://search.yahoo.com/mrss/" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title>${xmlEscape(site.title)}</title>
    <link>${xmlEscape(site.url)}</link>
    <description>${xmlEscape(site.description)}</description>
    <language>ru</language>
${items}
  </channel>
</rss>`;
}
