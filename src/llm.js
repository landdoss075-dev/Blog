import { config } from './config.js';
import { log } from './log.js';
import { buildMessages, parseArticle } from './prompt.js';
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

  const raw = await provider.call(buildMessages(topic));
  const article = parseArticle(raw);

  log.ok(`Статья готова: «${article.title}»`);
  return article;
}
