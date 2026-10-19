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
import { reviewFinanceArticle, appendFinanceReferences } from './finance-review.js';

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
  // Финансовый JSON включает 650–1000 русских слов и 7 заголовков: прежний
  // лимит 4000 часто исчерпывался до появления полного содержательного ответа.
  const callProvider = messages => provider.call(messages, topic.strictFinance ? { maxTokens: 8000, reasoningEffort: 'low' } : undefined);
  const rememberCandidate = async (candidate, issues) => {
    if (!options.onCandidate) return;
    try { await options.onCandidate(candidate, issues); }
    catch { log.warn('Не удалось сохранить личный черновик; контроль качества остаётся включённым.'); }
  };
  const checkCandidate = async candidate => {
    const issues = qualityIssues(candidate, topic);
    // Проверяем содержательный черновик даже при небольшом недоборе объёма:
    // иначе фактические ошибки впервые обнаруживаются после последней редактуры.
    if (topic.strictFinance && (candidate.bodyWords || 0) >= Math.min(topic.minWords || 650, 250)) {
      try { issues.push(...await reviewFinanceArticle(candidate, topic, callProvider)); }
      catch (error) {
        await rememberCandidate(candidate, [...issues, `Проверка не завершена: ${error.message}`]);
        throw error;
      }
    }
    await rememberCandidate(candidate, issues);
    return issues;
  };

  const callAndParse = async (messages, stage) => {
    let raw = '';
    try {
      raw = await callProvider(messages);
      if (!String(raw || '').trim()) {
        log.warn(`${stage}: пустой ответ — повторяю исходное задание один раз, без сочинения JSON из пустоты.`);
        raw = await callProvider(messages);
        if (!String(raw || '').trim()) throw new Error('два пустых ответа подряд');
      }
    } catch (err) {
      throw new Error(`${stage}: запрос к модели не удался (${err.message})`);
    }

    let candidate;
    try {
      candidate = parseArticle(raw, topic.cta);
    } catch (parseErr) {
      log.warn(`${stage}: ответ модели не разобран (${parseErr.message}) — восстанавливаю только JSON…`);
      try {
        const repaired = await callProvider(buildRepairMessages(raw, topic));
        candidate = parseArticle(repaired, topic.cta);
        log.ok(`${stage}: JSON восстановлен.`);
      } catch (repairErr) {
        throw new Error(`${stage}: восстановить JSON не удалось (${repairErr.message})`);
      }
    }
    selectDistinctTitle(candidate, topic.recentTitles, topic);
    return candidate;
  };

  const draft = await callAndParse(buildMessages(topic), 'Черновик');
  const draftIssues = await checkCandidate(draft);
  let article = draft;

  if (draftIssues.length) {
    let currentIssues = draftIssues;
    let maxRevisionAttempts = 2;

    for (let attempt = 1; attempt <= maxRevisionAttempts; attempt += 1) {
      log.warn(
        `${attempt === 1 ? 'Черновик требует редакторской доработки' : 'Повторная редактура требуется'}: ` +
        `${currentIssues.join('; ')}.`,
      );
      const revised = await callAndParse(
        buildRevisionMessages(article, currentIssues, topic),
        attempt === 1 ? 'Редактура' : `Редактура ${attempt}`,
      );
      const revisedIssues = await checkCandidate(revised);
      if (revisedIssues.length) log.warn(`Редактура ${attempt}: ${revisedIssues.join('; ')}.`);
      if (attempt === 2 && topic.strictFinance && revisedIssues.length
        && revisedIssues.every(issue => /^(тело слишком короткое|мало содержательного текста)/.test(issue))) {
        maxRevisionAttempts = 3;
        log.info('Смысловые проверки пройдены: одна дополнительная доработка только объёма, без снижения порогов.');
      }

      if (!revisedIssues.length) {
        article = revised;
        currentIssues = [];
        break;
      }

      const articleIssues = currentIssues;
      if (
        topic.strictFinance || revisedIssues.length < articleIssues.length ||
        (revisedIssues.length === articleIssues.length &&
          (revised.bodyWords || 0) >= (article.bodyWords || 0))
      ) {
        article = revised;
        currentIssues = revisedIssues;
      }

      if (attempt === maxRevisionAttempts) {
        throw new Error(
          `Статья не прошла контроль после ${maxRevisionAttempts === 2 ? 'двух' : 'трёх'} адресных редактур. ` +
          `Замечания: ${currentIssues.join('; ')}. ` +
          `Лучший вариант: ${article.bodyWords || 0} слов, ${article.bodyChars || 0} символов.`,
        );
      }
    }
    log.ok('Адресная редактура пройдена, все замечания исправлены.');
  }

  if (topic.strictFinance) appendFinanceReferences(article, topic);

  log.ok(
    `Статья готова: «${article.title}» ` +
    `(${article.bodyWords} слов, ${article.bodyChars} символов, заголовков: ${article.titleVariants.length})`,
  );
  return article;
}
