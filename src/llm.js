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

  // До 3 попыток. Ретрай нужен по двум причинам:
  //  1) битый ответ модели — parseArticle бросает (Sonnet иногда отдаёт невалидный JSON:
  //     неэкранированные кавычки/переводы строк в значениях). Раньше это роняло весь процесс.
  //  2) статья не дотянула по качеству (1 заголовок / короткое тело).
  const MAX_ATTEMPTS = 3;
  let article = null;
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let candidate;
    try {
      const raw = await provider.call(buildMessages(topic));
      candidate = parseArticle(raw, topic.cta);
    } catch (err) {
      lastError = err;
      log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: ответ модели не разобран (${err.message}) — перегенерирую…`);
      continue;
    }
    const issue = qualityIssue(candidate, topic);
    if (!issue) {
      article = candidate;
      break;
    }
    // Качество не дотянуло: на последней попытке публикуем как есть, иначе пробуем снова.
    if (attempt < MAX_ATTEMPTS) {
      log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: статья не дотянула (${issue}) — перегенерирую…`);
    } else {
      log.warn(`Последняя попытка тоже слабая (${issue}) — публикую как есть.`);
      article = candidate;
    }
  }

  if (!article) {
    throw new Error(`Не удалось получить валидную статью за ${MAX_ATTEMPTS} попыток. Последняя ошибка: ${lastError?.message || 'нет'}`);
  }

  log.ok(`Статья готова: «${article.title}» (${article.bodyWords} слов, заголовков: ${article.titleVariants.length})`);
  return article;
}
