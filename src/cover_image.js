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

function hashSeed(text = '') {
  let h = 2166136261;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function pickVariant(list, seed, offset = 0) {
  return list[(seed + offset) % list.length];
}

function coverDirections(article, niche) {
  const seed = hashSeed(`${niche?.key || 'default'}:${article.title}:${(article.tags || []).join(',')}`);
  const scenes = {
    ai: [
      'a person at a small kitchen table with a closed laptop and phone nearby',
      'hands holding a smartphone near a window, laptop closed on the table',
      'a modest home office desk with coffee, glasses, notebook closed, and soft daylight',
      'a student workspace with backpack, desk lamp, and phone face down',
      'a person thinking at a desk, technology present but screens not visible',
      'a quiet evening apartment scene with phone, mug, and paperwork turned blank-side down',
    ],
    dacha: [
      'hands planting seedlings in a real Russian dacha garden bed',
      'a greenhouse with tomatoes and cucumbers, tools on soil, no packaging',
      'fresh vegetables in a basket near garden beds and watering can',
      'an older gardener checking leaves in a small greenhouse',
      'a dacha path between beds with herbs, carrots, onions, and simple tools',
      'a summer garden table with harvested vegetables, jars without labels, and natural light',
    ],
    finance: [
      'a pensioner at a Russian kitchen table with coins, wallet, and calculator',
      'hands sorting coins and cash envelopes on a plain table',
      'a family budget scene with tea cups, wallet, calculator, no bills or documents',
      'an older couple discussing expenses in a modest kitchen',
      'close-up of coins, glasses, calculator, and a plain notebook turned closed',
      'a shopping basket with groceries, wallet, and coins on a kitchen table',
    ],
    family: [
      'two relatives talking quietly at a kitchen table in a Russian apartment',
      'a mother and adult child sitting near a window with tea cups',
      'a family living room scene with distance and silence in body language',
      'a calm conversation on a sofa, warm daylight, no screens',
      'hands around tea cups on a kitchen table, emotional everyday atmosphere',
      'a hallway moment between generations, coats and house slippers, realistic apartment',
    ],
    pets: [
      'a cat resting on a person’s lap in a cozy Russian apartment',
      'a dog near the doorway with leash and owner’s shoes, no labels',
      'a pet owner sitting on a sofa with a cat nearby, quiet mood',
      'close-up of a cat near a window with food bowl in the background',
      'a dog toy on the floor and a pet owner reaching down, warm home light',
      'a rescued cat hiding partly under a chair in a lived-in apartment',
    ],
    nostalgia: [
      'a polished Soviet wall unit with cups, lace cloth, and warm afternoon light',
      'retro apartment corner with armchair, floor lamp, and old radio',
      'hands opening a wooden cabinet drawer with household objects, no papers',
      'old kitchen table with enamel kettle, faceted glasses, and sunlight',
      'a room with vintage wallpaper, carpet, houseplants, and family photo frames',
      'retro household objects on a sideboard, warm nostalgic Russian apartment mood',
    ],
  };
  const compositions = [
    'medium shot with one clear human action',
    'close-up still life with hands and objects',
    'wide environmental shot with strong foreground subject',
    'over-the-shoulder documentary photo, screen not visible',
    'low angle near table or garden bed, natural perspective',
    'quiet cinematic side light with negative space for article cropping',
  ];
  const lighting = [
    'soft morning daylight',
    'warm evening light',
    'overcast natural light',
    'sunlight through a window',
    'gentle golden hour light',
    'realistic indoor ambient light',
  ];

  const list = scenes[niche?.key] || ['realistic everyday Russian home atmosphere'];
  return {
    scene: pickVariant(list, seed),
    composition: pickVariant(compositions, seed, 3),
    lighting: pickVariant(lighting, seed, 7),
  };
}

function buildCoverPrompt(article, niche) {
  const excerpt = toPlainText(article.html).slice(0, 280);
  const tags = (article.tags || []).slice(0, 4).join(', ');
  const direction = coverDirections(article, niche);
  return `Photorealistic editorial cover image for a Russian-language Dzen article.

Article title: ${article.title}
Article excerpt: ${excerpt}
Topic tags: ${tags}

Scene direction: ${direction.scene}.
Composition: ${direction.composition}.
Lighting: ${direction.lighting}.

Strict visual requirements:
- 16:9 horizontal cover, clear main subject, strong click-worthy composition.
- Realistic everyday Russian / Eastern European atmosphere, not glossy American stock.
- Make this cover visually distinct from a generic stock image for the same niche: vary location,
  foreground object, camera angle, age/body language of people, and emotional tone according to the article.
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
