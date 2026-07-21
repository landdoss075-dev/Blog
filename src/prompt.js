/**
 * Общая логика для всех провайдеров: системный промпт, сборка запроса,
 * парсинг и нормализация ответа модели. Не зависит от конкретного API.
 */
import { sanitizeHtml, toPlainText } from './sanitize.js';

/** Голос автора по умолчанию (ниша «Нейробудни»), если персона ниши не передана. */
const DEFAULT_PERSONA = 'Ты — опытный автор русскоязычного блога про ИИ-инструменты и нейросети.';

/**
 * Системный промпт под требования Дзена: живой язык, примеры, без шаблона.
 * Первая строка — «персона» (голос автора конкретной ниши), остальное — общие правила.
 */
export function buildSystemPrompt(persona = DEFAULT_PERSONA) {
  return `${persona}
Пишешь живым, человеческим языком: без канцелярита, без воды, без шаблонных фраз вроде
"в современном мире" и "не секрет, что". Используешь конкретные примеры, ситуации и цифры.

Жёсткие требования:
- Объём основного текста: 700-1100 слов.
- ЗАВЕРШИ статью коротким вопросом к читателю (чтобы спровоцировать комментарии).
- НИКОГДА не упоминай, что текст написан нейросетью или ИИ-ассистентом.
- Пиши так, будто делишься личным опытом.
- Личный опыт — это честный тест, наблюдение или проверка. Не выдумывай родственников,
  коллег, болезни, долги, находки чужих данных и драматичные события, если их нет в исходном
  новостном поводе.
- Первый абзац должен сразу давать живую сцену или проблему читателя, без длинного входа и
  без пересказа новости. 2-4 предложения, затем переход к сути.
- Никаких выдуманных фактов о конкретных датах/версиях, если не уверен.

КРИТИЧНО (площадка режет охваты шаблонному машинному тексту):
- Текст должен читаться как авторская колонка живого эксперта, а НЕ сгенерированный отчёт.
- Избегай ровного, одинакового ритма: чередуй короткие и длинные предложения,
  вставляй разговорные обороты, конкретику, имена, цифры, мелкие детали.
- ЗАПРЕЩЕНО начинать абзацы или разделы словами-маркерами: «Зацепка», «Суть проблемы»,
  «В чём проблема», «Конкретные шаги», «Что реально работает», «Коротко о проблеме».
  Переходы между мыслями делай живыми, как в человеческой статье.
- НЕ нумеруй механически «Шаг 1 / Шаг 2 / Шаг 3», если этого прямо не требует выбранный формат.
- Делай структуру для чтения: 3-5 коротких подзаголовков внутри статьи через <h2>.
- НЕ имитируй подзаголовки жирным абзацем вида <p><b>...</b></p>; для разделов используй только <h2>.
- Каждый <h2> должен быть понятным и живым: 3-8 слов, без точки в конце.

Ответ верни СТРОГО в формате JSON (без markdown-обёртки), по схеме:
Первый символ ответа должен быть {, последний символ ответа должен быть }.
{
  "titles": ["3 разных варианта заголовка, каждый до 90 символов, в разном стиле"],
  "html": "<p>...</p><p>...</p> — тело статьи в HTML, только теги p, h2, ul, li, b",
  "telegram": "версия для Telegram: 600-900 символов, с эмодзи и абзацами, без HTML-тегов кроме <b> и <i>",
  "image_query": "3-4 английских слова — КОНКРЕТНЫЙ визуальный объект, не абстракция",
  "image_queries": ["3 разных английских запроса для картинок: обложка, первая иллюстрация, вторая иллюстрация"],
  "tags": ["3-5", "коротких", "тегов"]
}`;
}

/**
 * Форматы подачи — выбираем случайный на каждый запуск, чтобы статьи не были клонами
 * по структуре (Дзен 2026 режет шаблонный машинный текст).
 */
const FORMATS = [
  'личная история из практики: как ты сам решал эту задачу — с деталями, ошибками и тем, что в итоге сработало',
  'разбор конкретного кейса: компания или человек, цифры «до» и «после», что именно дало результат',
  'разбор типичных ошибок: 4-5 граблей, на которые наступают все, и как их обойти',
  'честное сравнение инструментов: 3-4 решения, плюсы и минусы каждого, кому что подойдёт',
  'связный практический гайд от первого лица — БЕЗ механической нумерации «шагов», живым повествованием',
  'разбор мифа: что все думают про это vs как на самом деле, с конкретными доказательствами',
];

/**
 * Стили заголовка — выбираем случайный, чтобы уйти от штампа «[новость] — как сделать…»,
 * которым забита лента (низкий CTR из-за однообразия).
 */
const TITLE_STYLES = [
  'с цифрой в начале: «5 способов…», «3 ошибки…»',
  'вопрос-интрига: «Почему…?», «Что будет, если…?»',
  'личный опыт от первого лица: «Я попробовал … — вот что вышло»',
  'неожиданный контраст или провокация: «Все делают X. Зря.»',
  'обещание конкретной пользы без новостного повода в начале заголовка',
];

const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** Пользовательский промпт из темы дня. `topicLabel` — «про что» блог (для нейтральности к нише). */
export function buildUserPrompt({
  theme,
  headline,
  headlines,
  trendKeywords = [],
  recentTitles = [],
  recentTopicHints = [],
  topicLabel = 'про ИИ-инструменты',
  promptFormats = FORMATS,
  titleStyles = TITLE_STYLES,
  promptGuidance = [],
}) {
  const format = pick(promptFormats.length ? promptFormats : FORMATS);
  const titleStyle = pick(titleStyles.length ? titleStyles : TITLE_STYLES);
  const guidance = promptGuidance.length
    ? `\nНИШЕВЫЕ ПРАВИЛА:\n${promptGuidance.map((rule) => `- ${rule}`).join('\n')}\n`
    : '';
  return `Горячая тема дня: «${theme}».
Самый популярный новостной повод (зацепка для статьи):
"${headline}"

Другие заголовки дня по теме:
${headlines.slice(0, 5).map((h) => `- ${h}`).join('\n')}
${trendKeywords.length ? `\nКлючевые тренды дня: ${trendKeywords.join(', ')}.` : ''}

ФОРМАТ ПОДАЧИ для этой статьи (используй именно его, не сваливайся в общий шаблон):
→ ${format}
${guidance}

ФОРМАТ — «польза на поводе», НЕ пересказ новости:
- Используй этот горячий повод как зацепку в первом абзаце (чтобы кликали), но НЕ начинай со слова «Зацепка».
- Дальше дай ПРАКТИЧЕСКУЮ ценность: конкретные советы, личный опыт, примеры —
  то, ради чего статью дочитают до конца.
- Не пересказывай новость дословно и не копируй факты, в которых не уверен.
- Цель — максимум дочитываний и времени чтения: читатель должен унести из текста реальную пользу.
- Внутри статьи обязательно используй 3-5 подзаголовков <h2>. Они должны разделять смысловые блоки,
  а не быть жирным текстом внутри абзаца.

ЗАГОЛОВКИ (3 варианта, разные между собой):
- Стиль хотя бы одного: ${titleStyle}.
- НЕ используй шаблон «[новость] — как сделать…» через тире — им забита вся лента.
${recentTitles.length ? `- Эти заголовки уже выходили недавно — НЕ повторяй их структуру и формулировки:\n${recentTitles.slice(0, 8).map((t) => `  · ${t}`).join('\n')}` : ''}
${recentTopicHints.length ? `\nЗАПРЕЩЁННЫЕ ПОВТОРЫ:\nЭти инфоповоды уже были недавно. Не пересказывай их другими словами и не делай статью вокруг того же предмета/персоны/цифры:\n${recentTopicHints.slice(0, 8).map((t) => `  · ${t}`).join('\n')}` : ''}

КАРТИНКИ:
- Верни image_queries: ровно 3 разных английских поисковых запроса для Unsplash.
- 1-й запрос — обложка всей статьи, 2-й и 3-й — разные конкретные сцены/объекты из разных частей статьи.
- Не повторяй один и тот же смысл в трёх запросах. Плохо: ["garden", "vegetable garden", "summer garden"].
- Хорошо: ["greenhouse tomatoes", "watering garden beds", "preserving jars kitchen"].
- Каждый запрос: 2-5 английских слов, предметный, без абстракций вроде "success", "future", "lifestyle".

Напиши ОРИГИНАЛЬНУЮ статью для русскоязычной аудитории ${topicLabel}.`;
}

/** Сообщения для chat-completions (формат одинаков у Groq и OpenAI). */
export function buildMessages(topic) {
  return [
    { role: 'system', content: buildSystemPrompt(topic.persona) },
    { role: 'user', content: buildUserPrompt(topic) },
  ];
}

function truncateRepairSource(raw, max = 18000) {
  const s = String(raw || '');
  if (s.length <= max) return s;
  return `${s.slice(0, Math.floor(max * 0.7))}\n\n[...ответ обрезан...]\n\n${s.slice(-Math.floor(max * 0.3))}`;
}

/**
 * Восстановительный запрос: если Sonnet написал статью, но не отдал валидный JSON,
 * просим модель только переложить уже созданный материал в нужную схему.
 */
export function buildRepairMessages(raw, topic = {}) {
  return [
    {
      role: 'system',
      content:
        'Ты — строгий JSON-редактор. Твоя единственная задача — вернуть валидный JSON-объект без markdown, пояснений и текста вокруг. Первый символ ответа — {, последний — }.',
    },
    {
      role: 'user',
      content: `Преобразуй ответ модели ниже в валидный JSON для статьи ${topic.topicLabel || 'блога'}.

Схема:
{
  "titles": ["3 разных варианта заголовка до 90 символов"],
  "html": "<p>...</p><p>...</p> — тело статьи в HTML, только теги p, h2, ul, li, b",
  "telegram": "600-900 символов для Telegram, без HTML-тегов кроме <b> и <i>",
  "image_query": "3-4 английских слова для поиска конкретной картинки",
  "image_queries": ["3 разных английских запроса: обложка, первая иллюстрация, вторая иллюстрация"],
  "tags": ["3-5", "коротких", "тегов"]
}

Правила:
- Не добавляй новые факты и не переписывай статью с нуля.
- Если в исходном ответе нет 3 заголовков, придумай недостающие по смыслу уже написанной статьи.
- Если Telegram-версии нет, сделай краткую версию из статьи.
- Если в статье жирные псевдоподзаголовки вида <p><b>...</b></p>, преврати их в <h2>...</h2>.
- Если image_queries нет, добавь 3 разных предметных запроса по смыслу статьи.
- Верни только JSON. Никаких \`\`\`, вступлений, комментариев и пояснений.

Исходный ответ модели:
${truncateRepairSource(raw)}`,
    },
  ];
}

/**
 * Экранирует «сырые» управляющие символы (переводы строк, табы) ВНУТРИ строковых
 * значений JSON — частая поломка ответа модели, из-за которой JSON.parse падает.
 * Идём по символам, отслеживая, находимся ли внутри строки, и заменяем реальные
 * \n/\r/\t на их экранированные формы. Уже экранированные (\\) не трогаем.
 */
function escapeControlCharsInStrings(json) {
  let out = '';
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (ch === '\\') { out += ch; escaped = true; continue; }
    if (ch === '"') { inString = !inString; out += ch; continue; }
    if (inString) {
      if (ch === '\n') { out += '\\n'; continue; }
      if (ch === '\r') { out += '\\r'; continue; }
      if (ch === '\t') { out += '\\t'; continue; }
    }
    out += ch;
  }
  return out;
}

/** Достаёт JSON из ответа модели, даже если он обёрнут в текст/markdown или слегка «битый». */
export function extractJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1) {
    throw new Error('В ответе модели не найден JSON');
  }
  const slice = candidate.slice(start, end + 1);
  try {
    return JSON.parse(slice);
  } catch {
    // Частая поломка Sonnet — «сырые» переводы строк/табы внутри строковых значений.
    // Чиним и пробуем ещё раз (если и это не помогло — пусть бросит исходную ошибку выше по стеку).
    return JSON.parse(escapeControlCharsInStrings(slice));
  }
}

function normalizeArticleHtml(html) {
  return String(html || '')
    .replace(/<p>\s*<(?:b|strong)>\s*([^<]{3,90}?)\s*<\/(?:b|strong)>\s*<\/p>/gi, (_, text) => {
      const heading = toPlainText(text).trim().replace(/[.:;!?]+$/u, '');
      return heading ? `<h2>${heading}</h2>` : '';
    })
    .replace(/<p>\s*<(?:b|strong)>\s*([^<]{3,90}?)\s*<\/(?:b|strong)>\s*<br>\s*<\/p>/gi, (_, text) => {
      const heading = toPlainText(text).trim().replace(/[.:;!?]+$/u, '');
      return heading ? `<h2>${heading}</h2>` : '';
    });
}

function normalizeImageQueries(article) {
  const raw = Array.isArray(article.image_queries) ? article.image_queries : [];
  const queries = raw
    .concat(article.image_query || [])
    .map((q) => String(q || '').trim().toLowerCase())
    .filter(Boolean);
  const unique = [];
  const seen = new Set();
  for (const q of queries) {
    const key = q.replace(/[^a-z0-9 ]+/g, '').replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(q.slice(0, 80));
  }
  return unique.slice(0, 3);
}

/** Парсит сырой ответ модели в нормализованную и очищенную статью. */
export function parseArticle(raw, cta = {}) {
  if (!raw) throw new Error('Модель вернула пустой ответ');
  const article = extractJson(raw);

  // Поддержка обеих схем: новый `titles` (массив вариантов) и старый `title`.
  // Берём первый непустой вариант; остальные сохраняем в titleVariants (для A/B вручную).
  const titleList = Array.isArray(article.titles)
    ? article.titles.map((t) => toPlainText(String(t)).trim()).filter(Boolean)
    : [];
  const chosenTitle = titleList[0] || (article.title ? toPlainText(article.title).trim() : '');

  if (!chosenTitle || !article.html) {
    throw new Error('В статье отсутствует title/titles или html');
  }

  // Санитизация HTML — критично для автопостинга без присмотра.
  article.html = sanitizeHtml(normalizeArticleHtml(article.html));
  // Кол-во слов в теле — считаем ДО добавления CTA, чтобы CTA не завышал метрику.
  article.bodyWords = toPlainText(article.html).split(/\s+/).filter(Boolean).length;
  // CTA-подписка в конце (монетизация Дзена завязана на подписчиков). Доверенный HTML —
  // добавляется ПОСЛЕ санитайзера, поэтому здесь допустима гиперссылка <a> (в отличие от
  // тела от модели, где <a> вычищается). Ссылка на Telegram — одна, в конце, после пользы:
  // так Дзен не штрафует за внешнюю ссылку (контент полезен, читатель дочитал до неё).
  const tgUrl = cta.channelUrl || '';
  const tgName = cta.channelName || 'канал';
  const ctaTopic = cta.topicLabel || 'на эту тему';
  const tgLink = tgUrl
    ? ` А ещё больше — в нашем Telegram-канале <a href="${tgUrl}" target="_blank" rel="noopener">«${tgName}»</a>.`
    : '';
  article.html += `<p><b>Понравился разбор?</b> Подпишитесь на канал — впереди ещё больше материалов ${ctaTopic}.${tgLink} Своим опытом и вопросами делитесь в комментариях.</p>`;
  article.title = chosenTitle.slice(0, 120);
  article.titleVariants = titleList;
  article.tags = Array.isArray(article.tags) ? article.tags.map((t) => String(t).trim()).filter(Boolean) : [];
  // Telegram допускает только <b>/<i>; остальное вычищаем.
  const tg = article.telegram ? sanitizeHtml(article.telegram, ['b', 'i']) : toPlainText(article.html).slice(0, 900);
  article.telegram = tg;
  article.image_query = article.image_query || 'article illustration';
  article.image_queries = normalizeImageQueries(article);
  return article;
}

/**
 * Достаточно ли статья «качественная», чтобы публиковать без перегенерации.
 * Ловит осечки, когда модель игнорирует формат: 1 заголовок и/или куцый текст
 * (старый шаблон ~180 слов). Возвращает причину провала или null, если ок.
 */
function containsForbiddenTerm(text, terms = []) {
  const normalized = toPlainText(text).toLowerCase();
  return terms.find((term) => normalized.includes(String(term).toLowerCase()));
}

export function qualityIssue(article, { forbiddenTerms = [] } = {}) {
  if (!article.titleVariants || article.titleVariants.length < 2) {
    return `мало вариантов заголовка (${article.titleVariants?.length || 0}, нужно ≥2)`;
  }
  if ((article.bodyWords || 0) < 650) {
    return `тело слишком короткое (${article.bodyWords || 0} слов, нужно ≥650)`;
  }
  const h2Count = (article.html.match(/<h2>/g) || []).length;
  if (h2Count < 2) {
    return `мало подзаголовков h2 (${h2Count}, нужно ≥2)`;
  }
  if ((article.image_queries || []).length < 2) {
    return `мало разных запросов для картинок (${article.image_queries?.length || 0}, нужно ≥2)`;
  }
  const forbidden = containsForbiddenTerm(
    [article.title, article.html, article.telegram, ...(article.tags || [])].join(' '),
    forbiddenTerms,
  );
  if (forbidden) {
    return `найдено стоп-слово другой ниши: "${forbidden}"`;
  }
  return null;
}
