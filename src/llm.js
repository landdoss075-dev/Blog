import { config } from './config.js';
import { log } from './log.js';
import { buildMessages, parseArticle, qualityIssue } from './prompt.js';
import { callGroq } from './groq.js';
import { callOpenAI } from './openai.js';
import { callOpenRouter } from './openrouter.js';

/** Доступные провайдеры: какой клиент звать и какую модель показывать в логах. */
const PROVIDERS = {
  groq: { call: callGroq, model: () => config.groq.model, key: () => config.groq.apiKey },
  openai: { call: callOpenAI, model: () => config.openai.model, key: () => config.openai.apiKey },
  openrouter: {
    call: callOpenRouter,
    model: () => config.openrouter.model,
    key: () => config.openrouter.apiKey,
  },
};

/**
 * Генерирует статью у выбранного провайдера (PROVIDER=groq|openai)
 * и возвращает нормализованный объект статьи.
 */
export async function generateArticle(topic) {
  const name = config.provider;
  const provider = PROVIDERS[name];
  if (!provider) {
    throw new Error(`Неизвестный PROVIDER="${name}". Допустимо: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  if (!provider.key()) {
    throw new Error(`Для PROVIDER="${name}" не задан API-ключ.`);
  }

  log.info(`Генерация статьи: провайдер ${name}, модель ${provider.model()}…`);

  // Один ретрай: иногда модель игнорирует формат (1 заголовок / ~180 слов).
  // Перегенерируем заново (новый случайный формат/стиль), если статья не дотягивает.
  let article = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const raw = await provider.call(buildMessages(topic));
    const candidate = parseArticle(raw);
    const issue = qualityIssue(candidate);
    if (!issue) {
      article = candidate;
      break;
    }
    if (attempt === 1) {
      log.warn(`Статья не дотянула (${issue}) — перегенерирую…`);
    } else {
      log.warn(`Повтор тоже слабый (${issue}) — публикую как есть.`);
      article = candidate;
    }
  }

  log.ok(`Статья готова: «${article.title}» (${article.bodyWords} слов, заголовков: ${article.titleVariants.length})`);
  return article;
}
