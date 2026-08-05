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
  const aiGroup = article?.source?.topicGroup || 'practical';
  const aiScenes = {
    practical: [
      'the exact everyday task from the article represented by one useful physical result and the objects needed to create it',
      'hands organizing the article’s precise task at a clean table, with any phone or laptop screen turned away and unreadable',
      'the finished practical outcome promised by the title, shown as a believable home or small-office action rather than generic computer work',
      'one clear before-action moment from the task, centered on a familiar object with a purposeful human gesture',
    ],
    search: [
      'one large everyday object at the center of the reader’s exact question, photographed clearly with generous negative space',
      'a calm explanatory still life built from the specific document, photograph, phone, or household object named in the title',
      'the precise decision implied by the title shown through two or three physical objects, with no readable text or interface',
      'a close documentary image of the object a reader needs to prepare or check before using an AI service',
    ],
    lab: [
      'a clear side-by-side physical comparison of two approaches to the same simple task, with no labels or readable writing',
      'two contrasting arrangements of the exact objects from the article, photographed from above as a practical experiment',
      'a neutral tabletop test scene showing one variable changed between two otherwise similar setups',
      'hands comparing two versions of the same everyday result, with all screens and paper text fully unreadable',
    ],
    safety: [
      'the exact protective action from the title shown calmly through one phone, one familiar object, and a deliberate pause before acting',
      'a high-contrast close-up of the article’s specific risk object with a clear safe human response and no threatening imagery',
      'the moment a person verifies the exact request or file from the article using a trusted separate route, all interfaces unreadable',
      'one clear foreground object representing the risk, balanced by a calm protective action rather than fear or panic',
    ],
  };
  const scenes = {
    ai: aiScenes[aiGroup] || aiScenes.practical,
    dacha: [
      'the exact plant and visible symptom named in the article, photographed close enough to inspect in a real Russian dacha',
      'the precise seasonal garden action from the title, with the correct plant, simple tools, soil, and weather conditions',
      'a gardener’s hands performing the exact safe task described in the article, with the plant as the main subject',
      'the exact garden bed, shrub, greenhouse crop, or stored harvest from the article, showing the practical problem clearly',
      'a before-action documentary scene focused on the title’s specific plant condition, not a generic abundant harvest',
      'the concrete result a gardener needs to assess in this article, with seasonally accurate vegetation and modest surroundings',
    ],
    finance: [
      'the exact household payment, benefit, utility bill, pension, or document-check situation named in the title',
      'hands comparing the specific payment situation from the article using a calculator and unreadable paperwork',
      'an adult reader checking the exact benefit or household charge from the title in a modest Russian apartment',
      'the concrete money concern from the article shown through relevant objects, with no generic cash pile or luxury cues',
      'a close-up of the exact bill, wallet, calculator, glasses, or application context needed by the title, all text unreadable',
      'a calm consultation-like home scene centered on the article’s specific payment or document problem',
    ],
    family: [
      'the exact family relationship and emotional situation named in the article, shown through natural body language',
      'a believable domestic moment immediately before the conversation or decision described in the title',
      'the precise household conflict, distance, support, or reconciliation from the article in a Russian apartment',
      'two or three relatives of the appropriate ages in the exact setting implied by the title, without theatrical posing',
      'a close human detail from the article’s family scene, using hands, posture, distance, and relevant household objects',
      'the article’s central emotional turning point shown quietly and realistically, without melodrama',
    ],
    pets: [
      'the exact domestic animal and behavior named in the article, captured naturally in the species-appropriate home environment',
      'a close documentary view of the pet’s precise action, posture, and nearby object that the article asks the owner to notice',
      'the exact interaction between pet, owner, feeding area, enclosure, aquarium, resting place, toy, doorway, or leash described in the article',
      'the household environment behind the behavior in the title, with the animal clearly visible and no exaggerated expression',
      'the moment just before the owner changes the exact routine or object discussed in the article',
      'a realistic species-level camera view showing the article’s central behavior and relevant habitat layout',
    ],
    nostalgia: [
      'the exact household object named in the article, historically plausible for the stated decade and shown as the clear main subject',
      'hands using the precise old object or performing the exact domestic ritual from the title in an authentic apartment interior',
      'a close still life of the article’s specific object with only the few period-correct items needed to explain its everyday role',
      'the exact kitchen, hallway, courtyard, shop, or train ritual from the article, without mixing decades or adding random antiques',
      'a documentary-style domestic scene centered on the title’s object as it was actually stored, repaired, carried, or reused',
      'the article’s precise sensory memory represented by one period-correct object, believable wear, and restrained surroundings',
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
  const aiPalettes = {
    practical: 'clean neutral colors with one fresh cyan or green accent, useful and optimistic rather than futuristic',
    search: 'bright natural daylight, crisp object separation, restrained blue and warm neutral accents',
    lab: 'balanced neutral studio daylight with two visually distinct object arrangements',
    safety: 'clear high contrast with one restrained red accent, calm and protective rather than alarming',
  };

  const list = scenes[niche?.key] || ['realistic everyday Russian home atmosphere'];
  return {
    scene: pickVariant(list, seed),
    composition: pickVariant(compositions, seed, 3),
    lighting: pickVariant(lighting, seed, 7),
    palette: niche?.key === 'ai'
      ? aiPalettes[aiGroup] || aiPalettes.practical
      : 'natural, varied colors appropriate to the exact subject and season',
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
Color direction: ${direction.palette}.

Strict visual requirements:
- 16:9 horizontal cover, clear main subject, strong click-worthy composition.
- Realistic everyday Russian / Eastern European atmosphere, not glossy American stock.
- Make this cover visually distinct from a generic stock image for the same niche: vary location,
  foreground object, camera angle, age/body language of people, and emotional tone according to the article.
- Natural and believable, emotionally clear; vary color temperature according to the color direction.
- No text, no letters, no words, no captions, no logos, no brand marks.
- No legible UI screens, phone screens, documents, receipts, newspapers, posters, or signs.
  Relevant paper may appear only when the article requires it, with all text fully unreadable and no personal data.
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
