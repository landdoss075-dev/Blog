/**
 * Общая логика для всех провайдеров: системный промпт, сборка запроса,
 * парсинг и нормализация ответа модели. Не зависит от конкретного API.
 */
import { sanitizeHtml, toPlainText } from './sanitize.js';

/** Системный промпт под требования Дзена: живой язык, примеры, 500-800 слов, без упоминания ИИ. */
export const SYSTEM_PROMPT = `Ты — опытный автор русскоязычного блога про ИИ-инструменты и нейросети.
Пишешь живым, человеческим языком: без канцелярита, без воды, без шаблонных фраз вроде
"в современном мире" и "не секрет, что". Используешь конкретные примеры, кейсы и цифры.

Жёсткие требования:
- Объём основного текста: 500-800 слов.
- Структура: цепляющий заголовок → суть проблемы → 3-5 конкретных примеров/советов → краткий вывод.
- ЗАВЕРШИ статью коротким вопросом к читателю (чтобы спровоцировать комментарии).
- НИКОГДА не упоминай, что текст написан нейросетью или ИИ-ассистентом.
- Пиши так, будто делишься личным опытом.
- Никаких выдуманных фактов о конкретных датах/версиях, если не уверен.

Ответ верни СТРОГО в формате JSON (без markdown-обёртки), по схеме:
{
  "title": "заголовок до 90 символов",
  "html": "<p>...</p><p>...</p> — тело статьи в HTML, только теги p, h2, ul, li, b",
  "telegram": "версия для Telegram: 600-900 символов, с эмодзи и абзацами, без HTML-тегов кроме <b> и <i>",
  "image_query": "2-3 английских слова для поиска фото на Unsplash",
  "tags": ["3-5", "коротких", "тегов"]
}`;

/** Пользовательский промпт из темы дня. */
export function buildUserPrompt({ theme, headline, headlines, trendKeywords = [] }) {
  return `Горячая тема дня: «${theme}».
Самый популярный новостной повод (зацепка для статьи):
"${headline}"

Другие заголовки дня по теме:
${headlines.slice(0, 5).map((h) => `- ${h}`).join('\n')}
${trendKeywords.length ? `\nКлючевые тренды дня: ${trendKeywords.join(', ')}.` : ''}

ФОРМАТ — «польза на поводе», НЕ пересказ новости:
- Используй этот горячий повод как ЗАЦЕПКУ в заголовке и первом абзаце (чтобы кликали).
- Дальше дай ПРАКТИЧЕСКУЮ ценность: конкретные советы, кейсы, инструменты, примеры
  промптов — то, ради чего статью дочитают до конца.
- Не пересказывай новость дословно и не копируй факты, в которых не уверен.
- Цель — максимум дочитываний: читатель должен унести из текста что-то полезное.

Напиши ОРИГИНАЛЬНУЮ статью для русскоязычной аудитории про ИИ-инструменты.`;
}

/** Сообщения для chat-completions (формат одинаков у Groq и OpenAI). */
export function buildMessages(topic) {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(topic) },
  ];
}

/** Достаёт JSON из ответа модели, даже если он обёрнут в текст/markdown. */
export function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('В ответе модели не найден JSON');
  }
  return JSON.parse(candidate.slice(start, end + 1));
}

/** Парсит сырой ответ модели в нормализованную и очищенную статью. */
export function parseArticle(raw) {
  if (!raw) throw new Error('Модель вернула пустой ответ');
  const article = extractJson(raw);

  if (!article.title || !article.html) {
    throw new Error('В статье отсутствует title или html');
  }

  // Санитизация HTML — критично для автопостинга без присмотра.
  article.html = sanitizeHtml(article.html);
  // CTA-подписка в конце (монетизация Дзена завязана на подписчиков). Доверенный HTML.
  article.html += '<p><b>Понравился разбор?</b> Подпишитесь на канал — впереди ещё больше практичных статей про ИИ-инструменты. А вашим опытом и вопросами делитесь в комментариях.</p>';
  article.title = toPlainText(article.title).slice(0, 120);
  article.tags = Array.isArray(article.tags) ? article.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  // Telegram допускает только <b>/<i>; остальное вычищаем.
  const tg = article.telegram ? sanitizeHtml(article.telegram, ['b', 'i']) : toPlainText(article.html).slice(0, 900);
  article.telegram = tg;
  article.image_query = article.image_query || 'artificial intelligence';
  return article;
}
