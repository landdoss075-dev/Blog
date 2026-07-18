import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config, assertRequired } from '../src/config.js';
import { log } from '../src/log.js';
import { getNiche, nicheFromArgs, resolveSite, resolveTelegram } from '../src/niches.js';
import { fetchImages } from '../src/unsplash.js';
import { insertInlineImages, rebuildSite } from '../src/site.js';
import { postToTelegram } from '../src/telegram.js';

function truthy(v) {
  return v !== undefined && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

function removeInlineImages(html = '') {
  return html.replace(/<p>\s*<img\b[^>]*>\s*<\/p>/gi, '');
}

function inferImageQuery(post, niche) {
  const explicit = process.env.IMAGE_QUERY?.trim();
  if (explicit) return explicit;

  const text = `${post.title} ${(post.tags || []).join(' ')}`.toLowerCase();
  if (/картош|картоф/.test(text)) return 'potato harvest';
  if (/томат|помидор/.test(text)) return 'tomato plants';
  if (/огур/.test(text)) return 'cucumber garden';
  if (/рассад/.test(text)) return 'seedlings garden';
  if (/заготов|консерв/.test(text)) return 'homemade preserves';

  return niche.imageFallbackQueries?.[0] || 'vegetable garden';
}

async function loadPosts(dir) {
  const file = path.resolve(dir, 'posts.json');
  return JSON.parse(await readFile(file, 'utf8'));
}

async function main() {
  const niche = getNiche(nicheFromArgs() || 'dacha');
  const site = resolveSite(niche);
  const tgTarget = resolveTelegram(niche);
  const repostTelegram = truthy(process.env.REPOST_TELEGRAM ?? '1');
  const force = truthy(process.env.FORCE_REPAIR ?? '0');

  log.step(`Repair latest post images [${niche.key}]${config.dryRun ? ' — DRY RUN' : ''}`);
  assertRequired();

  const posts = await loadPosts(niche.dir);
  if (!posts.length) throw new Error(`В ${niche.dir}/posts.json нет статей.`);

  const post = posts[0];
  if (post.image && !force) {
    log.ok(`У последней статьи уже есть обложка: «${post.title}». Ничего не меняю.`);
    return;
  }

  const query = inferImageQuery(post, niche);
  log.info(`Последняя статья: «${post.title}»`);
  log.info(`Запрос картинок: "${query}"`);

  const images = await fetchImages(query, 3, niche.imageFallbackQueries || []);
  if (!images.length) {
    throw new Error('Не удалось подобрать картинки даже по запасным запросам.');
  }

  const cover = images[0];
  const inlineImages = images.slice(1);
  const originalHtml = removeInlineImages(post.html);
  post.image = { url: cover.url, author: cover.author || '' };
  post.html = insertInlineImages(originalHtml, inlineImages);

  if (config.dryRun) {
    log.ok(`DRY RUN: подобрал ${images.length} картинок, сайт/Telegram не меняю.`);
    return;
  }

  await rebuildSite(posts, site);

  if (repostTelegram) {
    const article = {
      title: post.title,
      html: originalHtml,
      tags: post.tags || [],
      telegram: '',
    };
    await postToTelegram(article, cover, tgTarget);
  }

  log.ok('Последняя статья обновлена и переотправлена с картинками.');
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
