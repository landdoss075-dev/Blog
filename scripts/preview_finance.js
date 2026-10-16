// Живой текстовый dry-run: нет Telegram, сайта, RSS или вызовов генератора изображений.
import { mkdir, writeFile } from 'node:fs/promises';
import { niches } from '../src/niches.js';
import { fetchTopic } from '../src/news.js';
import { loadFinanceSources } from '../src/finance-review.js';
import { generateArticle } from '../src/llm.js';
import { config } from '../src/config.js';

// Локальный .env исторически может содержать другую экспериментальную модель.
config.openrouter.model = process.env.FINANCE_PREVIEW_MODEL || 'anthropic/claude-sonnet-5';

const response = await fetch('https://finbudni.ru/posts.json', { signal: AbortSignal.timeout(20000) });
if (!response.ok) throw new Error(`История публикаций: HTTP ${response.status}`);
const recentPosts = await response.json();
const niche = niches.finance;
const forced = process.env.FINANCE_PREVIEW_TOPIC_ID
  ? niche.editorialTopics.find(item => item.id === process.env.FINANCE_PREVIEW_TOPIC_ID) : null;
if (process.env.FINANCE_PREVIEW_TOPIC_ID && !forced) throw new Error('Неизвестное задание для preview.');
const selected = forced ? { ...forced, headline: forced.theme, topicIntent: forced.intent, topicGroup: forced.group, topicOrigin: 'editorial', headlines: [forced.theme], currentDate: new Date().toISOString().slice(0, 10), recentTitles: recentPosts.map(p => p.title), recentSamples: recentPosts.slice(0, 5).map(p => ({ title: p.title, excerpt: p.excerpt })) } : await fetchTopic(niche, { recentPosts });
const topic = Object.assign(selected, {
  persona: niche.persona, editorialVoice: true, topicLabel: niche.topicLabel,
  promptFormats: niche.promptFormats, titleStyles: niche.titleStyles,
  promptGuidance: niche.promptGuidance, forbiddenTerms: niche.forbiddenTerms,
  minWords: niche.minWords, promptMinWords: niche.promptMinWords, maxWords: niche.maxWords,
  minChars: niche.minChars, minTitleVariants: 7, strictFinance: true, singleDaily: true,
  publicationSlot: 'evening', cta: { ...niche.cta, channelName: niche.channelName },
});
topic.factualSources = await loadFinanceSources(topic);
if (!topic.factualSources.length && topic.topicGroup !== 'budget') throw new Error('Нет прочитанных официальных источников.');
console.log(JSON.stringify({ assignment: topic.headline, origin: topic.topicOrigin, group: topic.topicGroup, score: topic.topicScore, reason: topic.selectionReason }));
const article = await generateArticle(topic, { name: 'openrouter' });
await mkdir('out', { recursive: true });
await writeFile('out/finance-review-preview.json', JSON.stringify({ topic, article }, null, 2));
await writeFile('out/finance-review-preview.html', `<!doctype html><meta charset="utf-8"><title>Черновик для проверки</title><body style="max-width:720px;margin:40px auto;font:18px/1.7 sans-serif"><h1>${article.title}</h1>${article.html}</body>`);
console.log(JSON.stringify({ title: article.title, words: article.bodyWords, sources: topic.factualSources.length, ctaCount: (article.html.match(/Чтобы не пропустить/g) || []).length, published: false }));
