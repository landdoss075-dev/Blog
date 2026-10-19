import test from 'node:test';
import assert from 'node:assert/strict';
import { generateFinanceWithFallback } from '../src/finance-generation.js';
import { niches } from '../src/niches.js';
import { fetchTopic } from '../src/news.js';
import { loadFinanceSources, reviewFinanceArticle, financeEvidenceSources } from '../src/finance-review.js';
import { sendFinanceFailure } from '../scripts/notify_finance_failure.js';

test('finance fallback generates exactly one approved result and excludes the failed assignment', async () => {
  const initial = { headline: 'Первая тема', topicId: 'pension-1', topicGroup: 'budget' };
  let attempts = 0;
  const result = await generateFinanceWithFallback(initial, {
    loadSources: async () => [],
    selectFallback: async failed => { assert.equal(failed, initial); return { headline: 'Другая тема', topicGroup: 'budget' }; },
    generate: async topic => { attempts++; if (attempts === 1) throw new Error('Контроль не пройден'); return { title: topic.headline }; },
  });
  assert.equal(result.attemptCount, 2);
  assert.equal(result.article.title, 'Другая тема');
  assert.equal(attempts, 2);
});

test('failed topics are bounded to two attempts and cannot yield an unreviewed article', async () => {
  let attempts = 0;
  await assert.rejects(generateFinanceWithFallback({ topicGroup: 'budget' }, {
    loadSources: async () => [], selectFallback: async () => ({ topicGroup: 'budget' }),
    generate: async () => { attempts++; throw new Error('Неподтверждённые факты'); },
  }), /Обе финансовые темы отклонены/);
  assert.equal(attempts, 2);
});

test('source unavailability selects another topic before requesting a legal draft', async () => {
  let generated = 0;
  const result = await generateFinanceWithFallback({ topicGroup: 'pension' }, {
    loadSources: async () => [], selectFallback: async () => ({ topicGroup: 'budget' }),
    generate: async () => { generated++; return { title: 'Арифметика' }; },
  });
  assert.equal(generated, 1);
  assert.equal(result.attemptCount, 2);
});

test('fallback keeps all thirty published exclusions and does not fetch weak news again', async () => {
  const recentPosts = niches.finance.editorialTopics.slice(0, 30).map(t => ({ title: t.theme, source: { topicId: t.id, headline: t.theme, topicGroup: t.group } }));
  const failed = niches.finance.editorialTopics[30];
  const result = await fetchTopic(niches.finance, { recentPosts, editorialFallback: true,
    excludedTopics: [{ topicId: failed.id, headline: failed.theme, topicGroup: failed.group }],
    fetchFeed: async () => { throw new Error('Новостной поиск не должен повторяться'); },
  });
  assert.ok(!recentPosts.some(p => p.source.topicId === result.topicId));
  assert.notEqual(result.topicId, failed.id);
  assert.equal(result.selectionReason, 'review-fallback');
});

test('EDV and NSU sources augment rather than replace pension and social supplement pages', async () => {
  const found = await loadFinanceSources({ topicGroup: 'pension', headline: 'Пенсия, ЕДВ, НСУ и социальная доплата' }, async url => ({
    ok: true, text: async () => `<main>${'Официальный материал для проверки правил. '.repeat(15)}</main>`,
  }));
  assert.equal(new Set(found.map(s => s.url)).size, found.length);
  assert.ok(found.some(s => s.url.endsWith('/edv')));
  assert.ok(found.some(s => s.url.includes('socialnaya_doplata')));
  assert.ok(found.some(s => s.url.includes('/nsu/')));
});

test('editor distinguishes referral advice and stylistic notes from factual blockers', async () => {
  const verdict = { onTopic: true, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: [], notes: ['Можно сократить повтор'] };
  const issues = await reviewFinanceArticle({ title: 'Уточните в СФР', bodyHtml: '<p>Спросите о своём случае в СФР.</p>' }, {}, async messages => {
    assert.ok(messages.some(m => m.role === 'system' && m.content.includes('не являются утверждениями о законе')));
    return JSON.stringify(verdict);
  });
  assert.deepEqual(issues, []);
});

test('invalid review JSON gets one syntax-only repair, preserving a rejection', async () => {
  let calls = 0;
  const issues = await reviewFinanceArticle({ title: 'Тема', bodyHtml: '<p>Текст</p>' }, {}, async messages => {
    calls++;
    if (calls === 1) return '{"onTopic":false,"titleMatches":true,"useful":true,"distinct":true,"factsSupported":true,invalid}';
    assert.match(messages.at(-1).content, /не заменяй false на true/);
    return JSON.stringify({ onTopic: false, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: ['Не по теме'] });
  });
  assert.equal(calls, 2);
  assert.deepEqual(issues, ['Не по теме']);
});

test('syntax repair cannot turn an editorial rejection into approval', async () => {
  let calls = 0;
  await assert.rejects(reviewFinanceArticle({ title: 'Тема', bodyHtml: '<p>Текст</p>' }, {}, async () => {
    calls++;
    return calls === 1
      ? '{"onTopic":false,"titleMatches":true,"useful":true,"distinct":true,"factsSupported":true,invalid}'
      : JSON.stringify({ onTopic: true, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: [] });
  }), /изменило вердикт/);
});

test('failure alert targets only an explicit private admin and does not include secrets in text', async () => {
  await sendFinanceFailure({ token: 'fake-token', chatId: '123', runUrl: 'https://github.com/test/actions/runs/1', fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.chat_id, '123');
    assert.ok(!body.text.includes('fake-token'));
    return { ok: true, json: async () => ({ ok: true }) };
  } });
  await assert.rejects(sendFinanceFailure({ token: 'fake-token', chatId: '-100123' }), /приватные/);
});

test('server-numbered evidence is literal source text and a model cannot invent an excerpt ID', async () => {
  const source = { url: 'https://sfr.gov.ru/example', text: 'Размер выплаты зависит от категории получателя и подтверждённых оснований.' };
  const evidence = financeEvidenceSources([source]);
  assert.equal(evidence[0].excerpts[0].text, source.text);
  const verdict = { onTopic: true, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: [], claims: [{ claim: 'Размер зависит от категории', sourceUrl: source.url, excerptId: evidence[0].excerpts[0].id }] };
  const topic = { factualSources: [source] };
  assert.deepEqual(await reviewFinanceArticle({ title: 'Выплата', bodyHtml: '<p>Размер зависит от категории.</p>' }, topic, async () => JSON.stringify(verdict)), []);
  verdict.claims[0].excerptId = 'invented';
  assert.ok((await reviewFinanceArticle({ title: 'Выплата', bodyHtml: '<p>Текст</p>' }, topic, async () => JSON.stringify(verdict))).some(issue => /не содержит/.test(issue)));
});

test('evidence chunking terminates for long content and preserves the final source sentence', () => {
  const text = 'Подтверждённое правило источника. '.repeat(300) + 'Конечная оговорка о применении.';
  const excerpts = financeEvidenceSources([{ url: 'https://sfr.gov.ru/test', text }])[0].excerpts;
  assert.ok(excerpts.length > 1 && excerpts.length < 30);
  assert.ok(excerpts.every(excerpt => text.includes(excerpt.text)));
  assert.ok(excerpts.at(-1).text.endsWith('Конечная оговорка о применении.'));
  assert.ok(financeEvidenceSources([{ text: 'x'.repeat(3000) }])[0].excerpts.length < 10);
});
