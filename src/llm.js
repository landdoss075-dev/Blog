import { config } from './config.js';
import { log } from './log.js';
import {
  buildMessages,
  buildRepairMessages,
  buildRevisionMessages,
  parseArticle,
  qualityIssues,
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
 * Генерирует статью у выбранного провайдера
 * и возвращает нормализованный объект статьи.
 */
export async function generateArticle(topic, options = {}) {
  const name = options.name || config.provider;
  const provider = options.provider || PROVIDERS[name];
  if (!provider) {
    throw new Error(`Неизвестный PROVIDER="${name}". Допустимо: ${Object.keys(PROVIDERS).join(', ')}.`);
  }
  if (!options.provider && !provider.key()) {
    throw new Error(`Для PROVIDER="${name}" не задан API-ключ.`);
  }

  log.info(`Генерация статьи: провайдер ${name}, модель ${provider.model()}…`);

  const callAndParse = async (messages, stage) => {
    let raw = '';
    try {
      raw = await provider.call(messages);
    } catch (err) {
      throw new Error(`${stage}: запрос к модели не удался (${err.message})`);
    }

    let candidate;
    try {
      candidate = parseArticle(raw, topic.cta);
    } catch (parseErr) {
      log.warn(`${stage}: ответ модели не разобран (${parseErr.message}) — восстанавливаю только JSON…`);
      try {
        const repaired = await provider.call(buildRepairMessages(raw, topic));
        candidate = parseArticle(repaired, topic.cta);
        log.ok(`${stage}: JSON восстановлен.`);
      } catch (repairErr) {
        throw new Error(`${stage}: восстановить JSON не удалось (${repairErr.message})`);
      }
    }
    selectDistinctTitle(candidate, topic.recentTitles);
    return candidate;
  };

  const draft = await callAndParse(buildMessages(topic), 'Черновик');
  const draftIssues = qualityIssues(draft, topic);
  let article = draft;

  if (draftIssues.length) {
    log.warn(`Черновик требует редакторской доработки: ${draftIssues.join('; ')}.`);
    article = await callAndParse(
      buildRevisionMessages(draft, draftIssues, topic),
      'Редактура',
    );
    const revisedIssues = qualityIssues(article, topic);
    if (revisedIssues.length) {
      const best = (article.bodyWords || 0) >= (draft.bodyWords || 0) ? article : draft;
      throw new Error(
        `Статья не прошла контроль после одной адресной редактуры. ` +
        `Замечания: ${revisedIssues.join('; ')}. ` +
        `Лучший вариант: ${best.bodyWords || 0} слов, ${best.bodyChars || 0} символов.`,
      );
    }
    log.ok('Адресная редактура пройдена, все замечания исправлены.');
  }

  log.ok(
    `Статья готова: «${article.title}» ` +
    `(${article.bodyWords} слов, ${article.bodyChars} символов, заголовков: ${article.titleVariants.length})`,
  );
  return article;
}
