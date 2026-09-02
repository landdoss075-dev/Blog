import assert from 'node:assert/strict';
import test from 'node:test';

import { generateArticle } from '../src/llm.js';
import { niches } from '../src/niches.js';
import { buildMessages, parseArticle, qualityIssues } from '../src/prompt.js';
import { toPlainText } from '../src/sanitize.js';

const topic = {
  persona: 'Ты — редактор тестового полезного канала.',
  editorialVoice: true,
  topicLabel: 'про полезные бытовые решения',
  theme: 'Как проверить бытовое решение до покупки',
  headline: 'Как проверить бытовое решение до покупки',
  headlines: ['Как проверить бытовое решение до покупки'],
  topicOrigin: 'editorial',
  currentDate: '2026-08-11',
  recentTitles: [],
  minWords: 80,
  promptMinWords: 80,
  maxWords: 600,
  minChars: 600,
  minTitleVariants: 7,
  cta: {
    channelUrl: 'https://t.me/example',
    channelName: 'Тестовый канал',
    topicLabel: 'на эту тему',
  },
};

function articleRaw({ strong = true } = {}) {
  const intro = strong
    ? 'Перед покупкой человек замечает одну странность: обещание звучит убедительно, но проверить его можно только по нескольким наблюдаемым признакам.'
    : 'В современном мире многие люди сталкиваются с разными бытовыми вопросами.';
  const paragraph = Array.from(
    { length: strong ? 15 : 3 },
    (_, index) => `Наблюдение ${index + 1} помогает проверить решение спокойно и без лишних расходов.`,
  ).join(' ');
  const html = strong
    ? `<p>${intro}</p>` +
      `<h2>Сначала смотрим на обещание</h2><p>${paragraph}</p>` +
      `<h2>Затем проверяем условия</h2><p>${paragraph}</p>` +
      `<h2>В конце сравниваем результат</h2><p>${paragraph}</p>`
    : `<p>${intro}</p><h2>Что проверить</h2><p>${paragraph}</p>`;
  const titles = strong
    ? [
      'Покупка выглядит выгодной: какие три детали проверить заранее',
      'Почему громкое обещание не всегда означает полезное решение',
      'Три признака, которые помогают не ошибиться перед покупкой',
      'Сначала проверка, потом оплата: спокойный способ выбрать нужное',
      'Что сравнить перед покупкой, чтобы не платить за красивое обещание',
      'Одна проверка до покупки экономит деньги и время после неё',
      'Как отличить полезное решение от убедительной рекламы',
    ]
    : ['Как выбрать решение', 'Что проверить перед покупкой'];

  return JSON.stringify({
    titles,
    html,
    telegram: 'Короткая версия материала для Telegram с понятным выводом.',
    image_query: 'hands home table',
    image_queries: strong
      ? ['hands home table', 'person checking object', 'family comparing items']
      : ['hands home table'],
    tags: ['проверка', 'покупка', 'быт'],
  });
}

test('редакционный контроль находит короткий шаблонный черновик', () => {
  const article = parseArticle(articleRaw({ strong: false }), topic.cta);
  const issues = qualityIssues(article, topic);

  assert.ok(issues.some((issue) => /мало разных вариантов заголовка/.test(issue)));
  assert.ok(issues.some((issue) => /тело слишком короткое/.test(issue)));
  assert.ok(issues.some((issue) => /шаблонное вступление/.test(issue)));
  assert.ok(issues.some((issue) => /мало подзаголовков/.test(issue)));
});

test('промпт запрашивает редакционное задание и семь заголовков', () => {
  const messages = buildMessages(topic);

  assert.match(messages[0].content, /7 разных вариантов заголовка/);
  assert.match(messages[1].content, /РЕДАКЦИОННОЕ ЗАДАНИЕ/);
  assert.match(messages[1].content, /ровно 7 вариантов/);
});

test('финансовые слоты получают разные редакционные углы', () => {
  const morning = buildMessages({ ...topic, publicationSlot: 'morning' });
  const evening = buildMessages({ ...topic, publicationSlot: 'evening' });

  assert.match(morning[1].content, /СЛОТ ПУБЛИКАЦИИ — УТРО/);
  assert.match(morning[1].content, /который читатель может проверить сегодня/);
  assert.match(evening[1].content, /СЛОТ ПУБЛИКАЦИИ — ВЕЧЕР/);
  assert.match(evening[1].content, /Не повторяй утренний тип материала/);
});

test('финансовый CTA зовёт подписаться и не уводит в Telegram', () => {
  const article = parseArticle(articleRaw({ strong: true }), {
    channelUrl: 'https://t.me/finanbudni',
    channelName: niches.finance.channelName,
    topicLabel: niches.finance.topicLabel,
    ...niches.finance.cta,
  });

  assert.match(article.html, /Чтобы не пропустить следующие разборы/);
  assert.match(article.html, /Финансовые будни/);
  assert.doesNotMatch(article.html, /t\.me\/finanbudni/);
});

test('длинный первый абзац автоматически делится перед финальным контролем', () => {
  const payload = JSON.parse(articleRaw({ strong: true }));
  const longIntro = [
    'Утром человек открывает уведомление о выплате и видит знакомую сумму, но одна строка в справке выглядит не так, как месяц назад.',
    'Сначала кажется, что это обычная техническая подпись, которую можно не читать.',
    'Потом выясняется, что именно в этой строке часто прячется причина задержки, отказа или лишнего похода с документами.',
    'Если пропустить её сразу, через несколько недель приходится заново собирать бумаги и объяснять то, что можно было проверить за пять минут.',
    'Поэтому полезнее начать не с общих разговоров о законах, а с простой проверки: какая строка изменилась, кто её добавил и что она требует от заявителя.',
    'Такой подход не обещает чудес, зато помогает спокойно понять, где реальная проблема, а где просто формулировка ведомства.',
  ].join(' ');

  payload.html = payload.html.replace(/<p>[\s\S]*?<\/p>/, `<p>${longIntro}</p>`);

  const article = parseArticle(JSON.stringify(payload), topic.cta);
  const firstParagraph = toPlainText(article.html.match(/<p>([\s\S]*?)<\/p>/i)?.[1] || '');

  assert.ok(firstParagraph.length <= 650);
  assert.ok(!qualityIssues(article, topic).some((issue) => /первый абзац слишком длинный/.test(issue)));
});

test('каждая ниша использует свой редакционный диапазон', () => {
  const expected = {
    ai: [500, 750, 3000],
    dacha: [650, 900, 4000],
    finance: [650, 1000, 4000],
    family: [650, 900, 4000],
    pets: [600, 850, 3600],
    nostalgia: [650, 850, 3800],
  };

  for (const [key, [minWords, maxWords, minChars]] of Object.entries(expected)) {
    assert.equal(niches[key].minWords, minWords, key);
    assert.equal(niches[key].maxWords, maxWords, key);
    assert.equal(niches[key].minChars, minChars, key);
    assert.ok(niches[key].promptMinWords >= minWords, key);
  }
});

test('слабый черновик проходит ровно одну адресную редактуру', async () => {
  const responses = [articleRaw({ strong: false }), articleRaw({ strong: true })];
  const calls = [];
  const provider = {
    model: () => 'test-model',
    call: async (messages) => {
      calls.push(messages);
      return responses.shift();
    },
  };

  const article = await generateArticle(topic, { provider, name: 'test' });

  assert.equal(calls.length, 2);
  assert.match(calls[1][1].content, /Замечания редактора/);
  assert.doesNotMatch(calls[1][1].content, /t\.me\/example/);
  assert.equal(qualityIssues(article, topic).length, 0);
});

test('после одной неудачной редактуры публикация останавливается', async () => {
  let calls = 0;
  const provider = {
    model: () => 'test-model',
    call: async () => {
      calls += 1;
      return articleRaw({ strong: false });
    },
  };

  await assert.rejects(
    generateArticle(topic, { provider, name: 'test' }),
    /не прошла контроль после одной адресной редактуры/,
  );
  assert.equal(calls, 2);
});
