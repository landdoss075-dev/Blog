import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { scoreFinanceReaderValue, financeReaderBrief } from '../src/finance-reader.js';
import { fetchTopic, pickEditorialTopic } from '../src/news.js';
import { buildMessages, buildRevisionMessages, selectDistinctTitle } from '../src/prompt.js';
import { reviewFinanceArticle } from '../src/finance-review.js';
import { generateArticle } from '../src/llm.js';
import { niches } from '../src/niches.js';

const now = new Date('2026-10-20T15:00:00Z');
const approve = { onTopic: true, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: [] };
const financeTopic = overrides => ({ ...niches.finance, headline: 'Расходы до следующей зарплаты: как сравнить суммы и даты', theme: 'Расходы до следующей зарплаты: как сравнить суммы и даты', topicOrigin: 'editorial',
  topicGroup: 'budget', currentDate: '2026-10-20', minWords: 1, minChars: 1, maxWords: 1000, promptMinWords: 800, factualSources: [], ...overrides });

test('reader value distinguishes a concrete money question from an institutional announcement and is not a reach forecast', () => {
  const useful = scoreFinanceReaderValue({ theme: 'Доплата к пенсии изменилась: какие суммы проверить', group: 'pension' }, { editorial: true });
  const vague = scoreFinanceReaderValue({ title: 'СФР подвёл итоги заседания о пенсионных выплатах' });
  assert.ok(useful.total > vague.total);
  assert.equal(useful.parts.question, 4); // Cyrillic word boundaries must actually work.
  assert.equal(useful.parts.usefulAction, 4);
  assert.equal(useful.factsVerified, false);
  assert.equal(useful.basis, 'editorial-potential');
  assert.ok(useful.total <= 20 && vague.total >= 0);
  const regional = scoreFinanceReaderValue('Доплата к пенсии в Тюменской области: какие суммы проверить');
  assert.equal(regional.parts.audience, 2);
  assert.equal(scoreFinanceReaderValue('СФР провёл совещание').total, 0);
});

test('editorial selection compares candidates by reader value but preserves exclusions and group diversity', () => {
  const topics = [
    { id: 'p0', group: 'pension', theme: 'СФР подвёл итоги заседания о пенсионных выплатах' },
    { id: 'p1', group: 'pension', theme: 'Доплата к пенсии изменилась: какие суммы проверить' },
    { id: 'h1', group: 'housing', theme: 'Двойная оплата воды: как сверить платежи в квитанции' },
  ];
  const niche = { ...niches.finance, editorialTopics: topics };
  const first = pickEditorialTopic(niche, [], now);
  assert.equal(first.id, 'p1');
  assert.equal(first.readerSelection.shortlist.length, 3);
  const recent = [{ title: 'Другой заголовок', date: now.toISOString(), source: { topicId: 'p1', headline: topics[1].theme, topicGroup: 'pension' } }];
  assert.equal(pickEditorialTopic(niche, recent, now).id, 'h1');
  assert.notEqual(pickEditorialTopic(niche, [], now, [{ topicId: 'p1' }]).id, 'p1');
});

test('high-frequency low-value announcements do not displace a qualified practical news item', async () => {
  const items = [
    ...Array.from({ length: 20 }, (_, i) => ({ title: `СФР подвёл итоги заседания о пенсионных выплатах и бюджете ${i}`, isoDate: now.toISOString() })),
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Квитанция за воду оплачена дважды: как проверить начисления ${i}`, isoDate: now.toISOString() })),
  ];
  const topic = await fetchTopic({ ...niches.finance, newsQueries: ['test'] }, { now, recentPosts: [], fetchFeed: async () => items });
  assert.equal(topic.topicOrigin, 'news');
  assert.match(topic.headline, /Квитанция/);
  assert.ok(topic.topicScore >= niches.finance.minNewsTopicScore);
  assert.ok(topic.readerSelection.readerValue.total >= niches.finance.minNewsReaderValueScore);
  assert.equal(topic.readerSelection.readerValue.factsVerified, false);
});

test('a high trend score alone cannot prevent a safe editorial fallback', async () => {
  const items = Array.from({ length: 20 }, (_, i) => ({ title: `СФР подвёл итоги заседания о пенсионных выплатах и бюджете ${i}`, isoDate: now.toISOString() }));
  const topic = await fetchTopic({ ...niches.finance, newsQueries: ['test'] }, { now, recentPosts: [], fetchFeed: async () => items });
  assert.equal(topic.topicOrigin, 'editorial');
  assert.equal(topic.selectionReason, 'low-reader-value');
  assert.ok(topic.rejectedNewsScore >= 20);
  assert.ok(topic.rejectedReaderValue < 12);
});

test('news reader-value bonus cannot turn a below-threshold trend into a strong event', async () => {
  const topic = await fetchTopic({ ...niches.finance, newsQueries: ['test'] }, { now, recentPosts: [], fetchFeed: async () => [{ title: 'Повторная оплата воды: как сверить платежи', isoDate: now.toISOString() }] });
  assert.equal(topic.topicOrigin, 'editorial');
  assert.equal(topic.selectionReason, 'low-score');
});

test('reader contract is present in finance system, task and revision prompts, never in other niches', () => {
  const topic = financeTopic();
  const messages = buildMessages(topic);
  assert.match(messages[0].content, /ЧИТАТЕЛЬСКИЙ КОНТРАКТ/);
  assert.match(messages[0].content, /пункты меню/);
  assert.match(messages[0].content, /первые два абзаца/iu);
  assert.match(messages[1].content, /ЗАДАЧА ЧИТАТЕЛЯ/);
  assert.match(messages[1].content, /Не считай рейтинг темы подтверждением фактов/);
  const revision = buildRevisionMessages({ titleVariants: [], bodyHtml: '<p>Текст</p>' }, ['Нет конкретного ответа'], topic);
  assert.match(revision[0].content, /ЧИТАТЕЛЬСКИЙ КОНТРАКТ/);
  assert.match(revision[1].content, /убери неподтверждённое/);
  assert.ok(revision[1].content.includes(financeReaderBrief(topic).question));
  const other = buildMessages({ theme: 'Проверка ответа нейросети', headlines: [], strictFinance: false });
  assert.doesNotMatch(other[0].content + other[1].content, /ЧИТАТЕЛЬСКИЙ КОНТРАКТ|ЗАДАЧА ЧИТАТЕЛЯ/);
});

test('finance title selection prefers the money question to an institutional announcement without banning agency names', () => {
  const article = { titleVariants: ['СФР разъяснил, почему изменилась сумма доплаты к пенсии', 'Доплата к пенсии изменилась: что сравнить перед обращением'] };
  selectDistinctTitle(article, [], { strictFinance: true });
  assert.equal(article.title, article.titleVariants[1]);
  const agencyIsTheQuestion = { titleVariants: ['СФР или МФЦ: куда обращаться с вопросом о пенсионной выплате', 'Новые правила обращения по вопросам пенсионных выплат'] };
  selectDistinctTitle(agencyIsTheQuestion, [], { strictFinance: true });
  assert.equal(agencyIsTheQuestion.title, agencyIsTheQuestion.titleVariants[0]);
});

test('the existing single semantic review checks practical payoff and operational evidence with no new verdict fields', async () => {
  let calls = 0;
  const issues = await reviewFinanceArticle({ title: 'Как проверить платёж', bodyHtml: '<p>Банк сам объединяет все выплаты в один перевод.</p>' }, financeTopic(), async messages => {
    calls++;
    assert.ok(messages.some(m => m.role === 'system' && /механику доставки/.test(m.content)));
    assert.ok(messages.some(m => m.role === 'system' && /issues только конкретные препятствия/.test(m.content)));
    const task = JSON.parse(messages.at(-1).content);
    assert.match(task.readerContract.evidenceLimit, /Не выдумывай перевод денег банком/);
    return JSON.stringify({ ...approve, factsSupported: false, issues: ['Не подтверждено объединение выплат банком: убери это утверждение.'] });
  });
  assert.equal(calls, 1);
  assert.match(issues[0], /Не подтверждено/);
});

test('a useful bounded budget example still needs only the usual draft and one review, without paid external calls', async () => {
  const payload = {
    titles: Array.from({ length: 7 }, (_, i) => `Расходы до следующей зарплаты: сравнение сумм и дат ${i + 1}`),
    html: '<p>Если денег до зарплаты не хватает, сначала сравните обязательные расходы и даты поступлений. Даже когда месячный итог сходится, платёж может оказаться раньше дохода — это разные задачи.</p>'
      + '<h2>Что сравнить в своём списке</h2><p>Отметьте известные вам даты и суммы расходов. Отделите обязательное от покупки, которую готовы отложить сами.</p>'
      + '<h2>Условный пример без правил банка</h2><p>Предположим, до дохода осталось пять дней. Сравните остаток с собственным списком обязательных расходов за эти дни; это условный пример, а не требование закона.</p>'
      + '<h2>Как проверить свой результат</h2><p>Повторите сравнение со своими числами. Отрицательный остаток показывает разрыв до даты дохода, а не автоматически нехватку за весь месяц.</p>',
    image_queries: ['coins wallet table', 'cash envelope home', 'shopping basket groceries'], tags: ['бюджет'],
  };
  let calls = 0;
  await generateArticle(financeTopic(), { name: 'test', provider: { model: () => 'test', call: async () => ++calls === 1 ? JSON.stringify(payload) : JSON.stringify(approve) } });
  assert.equal(calls, 2);
});

test('editorial changes do not alter the automatic workflow, image/Telegram integrations or paid attempt budget', async () => {
  const workflow = await readFile(new URL('../.github/workflows/daily_finance_post.yml', import.meta.url), 'utf8');
  assert.match(workflow, /group: finance-post/);
  assert.match(workflow, /failure\(\) && !inputs.dry_run/);
  assert.match(workflow, /node scripts\/generate_and_post.js --niche=finance/);
  const generator = await readFile(new URL('../scripts/generate_and_post.js', import.meta.url), 'utf8');
  assert.match(generator, /readerSelection: topic.readerSelection/);
  assert.match(generator, /fetchImages\(inlineQueries, 2/);
});
