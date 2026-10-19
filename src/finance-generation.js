import { loadFinanceSources } from './finance-review.js';
import { generateArticle } from './llm.js';
import { log } from './log.js';

// Обе попытки целиком проходят ДО картинок и любых публикаций.
// Ошибку отправки в Telegram/сайт нельзя обрабатывать повторной генерацией.
export async function generateFinanceWithFallback(initialTopic, {
  selectFallback, loadSources = loadFinanceSources, generate = generateArticle,
} = {}) {
  let topic = initialTopic;
  const failures = [];
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      if (attempt === 2) topic = await selectFallback(initialTopic);
      topic.factualSources = await loadSources(topic);
      if (!topic.factualSources.length && topic.topicGroup !== 'budget') {
        throw new Error('Ни один официальный источник не прочитан — генерация этой темы остановлена.');
      }
      log.info(`Финансовая попытка ${attempt}/2: «${topic.headline}», источников=${topic.factualSources.length}.`);
      const article = await generate(topic);
      return { topic, article, attemptCount: attempt };
    } catch (error) {
      failures.push(error.message);
      log.warn(`Финансовая попытка ${attempt}/2 остановлена: ${error.message}`);
      if (attempt === 1) log.info('Пробую другую неповторяющуюся редакционную тему с полным контролем качества.');
    }
  }
  throw new Error(`Обе финансовые темы отклонены, ничего не опубликовано: ${failures.map((reason, i) => `${i + 1}) ${reason}`).join('; ')}`);
}
