import { config } from './config.js';
import { log } from './log.js';
import {
  buildMessages,
  buildRepairMessages,
  parseArticle,
  qualityIssue,
  selectDistinctTitle,
} from './prompt.js';
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
  let bestCandidate = null;
  let bestIssue = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let candidate;
    let raw = '';
    try {
      raw = await provider.call(buildMessages(topic));
      candidate = parseArticle(raw, topic.cta);
      selectDistinctTitle(candidate, topic.recentTitles);
    } catch (err) {
      if (!raw) {
        lastError = err;
        log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: генерация не удалась (${err.message}) — перегенерирую…`);
        continue;
      }
      log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: ответ модели не разобран (${err.message}) — пробую восстановить JSON…`);
      try {
        const repaired = await provider.call(buildRepairMessages(raw, topic));
        candidate = parseArticle(repaired, topic.cta);
        selectDistinctTitle(candidate, topic.recentTitles);
        log.ok(`Попытка ${attempt}/${MAX_ATTEMPTS}: JSON восстановлен, продолжаю публикацию.`);
      } catch (repairErr) {
        lastError = repairErr;
        log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: восстановить JSON не удалось (${repairErr.message}) — перегенерирую…`);
        continue;
      }
    }
    const issue = qualityIssue(candidate, topic);
    if (!issue) {
      article = candidate;
      break;
    }
    if (!bestCandidate || (candidate.bodyWords || 0) > (bestCandidate.bodyWords || 0)) {
      bestCandidate = candidate;
      bestIssue = issue;
    }
    lastError = new Error(issue);

    // Слабый материал нельзя отправлять дальше в изображения, Telegram и RSS.
    if (attempt < MAX_ATTEMPTS) {
      log.warn(`Попытка ${attempt}/${MAX_ATTEMPTS}: статья не дотянула (${issue}) — перегенерирую…`);
    } else {
      log.warn(`Последняя попытка тоже слабая (${issue}) — публикация отменена.`);
    }
  }

  if (!article) {
    const bestSummary = bestCandidate
      ? ` Лучший вариант: ${bestCandidate.bodyWords || 0} слов (${bestIssue}).`
      : '';
    throw new Error(
      `Не удалось получить качественную статью за ${MAX_ATTEMPTS} попыток.${bestSummary} ` +
      `Последняя ошибка: ${lastError?.message || 'нет'}`,
    );
  }

  log.ok(`Статья готова: «${article.title}» (${article.bodyWords} слов, заголовков: ${article.titleVariants.length})`);
  return article;
}
