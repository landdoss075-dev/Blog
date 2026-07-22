import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { log } from './log.js';
import { slugify } from './site.js';
import { toPlainText } from './sanitize.js';

const OPENROUTER_IMAGES_API = 'https://openrouter.ai/api/v1/images';

const EXT_BY_MEDIA = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

function extFromMedia(mediaType = '', fallback = 'jpg') {
  return EXT_BY_MEDIA[String(mediaType).toLowerCase()] || fallback;
}

function nicheScene(niche) {
  const scenes = {
    ai: 'ordinary Russian home office, phone and laptop nearby, warm daylight, practical technology mood',
    dacha: 'real Russian dacha garden, greenhouse, beds, tools, warm natural daylight',
    finance: 'Russian kitchen table, wallet, coins, calculator, family budget atmosphere',
    family: 'cozy Russian apartment kitchen or living room, calm family conversation, warm daylight',
    pets: 'home interior with a cat or dog, cozy everyday pet owner atmosphere',
    nostalgia: 'old Russian apartment interior, retro household objects, warm nostalgic daylight',
  };
  return scenes[niche?.key] || 'realistic everyday Russian home atmosphere';
}

function buildCoverPrompt(article, niche) {
  const excerpt = toPlainText(article.html).slice(0, 280);
  const tags = (article.tags || []).slice(0, 4).join(', ');
  return `Photorealistic editorial cover image for a Russian-language Dzen article.

Article title: ${article.title}
Article excerpt: ${excerpt}
Topic tags: ${tags}

Scene direction: ${nicheScene(niche)}.

Strict visual requirements:
- 16:9 horizontal cover, clear main subject, strong click-worthy composition.
- Realistic everyday Russian / Eastern European atmosphere, not glossy American stock.
- Natural light, human, warm, believable, emotionally clear.
- No text, no letters, no words, no captions, no logos, no brand marks.
- No UI screens, no readable phone screens, no documents, no receipts, no newspapers, no posters, no signs.
- Do not include surreal elements, infographics, icons, charts, typography, watermarks, or borders.
- Image must work as the first cover of an online article and be safe for a broad audience.`;
}

async function callOpenRouterImage(prompt) {
  const payload = {
    model: config.image.openrouterModel,
    prompt,
    n: 1,
    aspect_ratio: config.image.aspectRatio,
    resolution: config.image.resolution,
    output_format: config.image.outputFormat,
  };

  const res = await fetch(OPENROUTER_IMAGES_API, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://github.com/landdoss075-dev/Blog',
      'X-Title': 'Blog Autoposter',
    },
    body: JSON.stringify(payload),
  });

  const body = await res.text();
  if (!res.ok) {
    throw new Error(`OpenRouter Images ${res.status}: ${body.slice(0, 300)}`);
  }
  const data = JSON.parse(body);
  const image = data.data?.[0];
  if (!image?.b64_json) {
    throw new Error('OpenRouter Images вернул ответ без b64_json');
  }
  return { b64: image.b64_json, mediaType: image.media_type || `image/${config.image.outputFormat}`, usage: data.usage || null };
}

function coverTarget(article, site, niche) {
  const date = new Date().toISOString();
  const slug = slugify(article.title, date);
  const filenameBase = `${slug}-cover`;
  if (config.dryRun) {
    const dir = path.resolve(niche.key === 'ai' ? 'out' : path.join(path.dirname(niche.dir), 'out'), 'covers');
    return { dir, urlBase: 'covers', filenameBase };
  }
  const dir = path.resolve(site.dir, 'assets', 'covers');
  return { dir, urlBase: `${site.url}/assets/covers`, filenameBase };
}

export async function generateCoverImage(article, site, niche) {
  if (config.image.provider !== 'openrouter') return null;
  if (!site?.url || !site?.dir) {
    log.warn('Сайт ниши не задан — пропускаю генерацию обложки через OpenRouter.');
    return null;
  }

  const prompt = buildCoverPrompt(article, niche);
  log.info(`Генерация обложки: OpenRouter ${config.image.openrouterModel}, ${config.image.aspectRatio}, ${config.image.resolution}…`);

  const { b64, mediaType, usage } = await callOpenRouterImage(prompt);
  const ext = extFromMedia(mediaType, config.image.outputFormat === 'png' ? 'png' : 'jpg');
  const target = coverTarget(article, site, niche);
  await mkdir(target.dir, { recursive: true });
  const filename = `${target.filenameBase}.${ext}`;
  const filePath = path.join(target.dir, filename);
  await writeFile(filePath, Buffer.from(b64, 'base64'));

  const url = config.dryRun ? `${target.urlBase}/${filename}` : `${target.urlBase}/${filename}`;
  const cost = typeof usage?.cost === 'number' ? `, cost ~$${usage.cost.toFixed(4)}` : '';
  log.ok(`Обложка Nano Banana сохранена: ${filename}${cost}`);

  return {
    url,
    localPath: filePath,
    filename,
    mediaType,
    author: 'AI-generated cover',
    provider: 'openrouter',
    model: config.image.openrouterModel,
  };
}
