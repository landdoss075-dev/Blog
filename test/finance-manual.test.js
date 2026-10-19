import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFinanceDraftRecorder, renderFinanceDraftDocument } from '../src/finance-drafts.js';
import { readConfirmedDraft, validateManualRequest, buildSavedFinanceArticle, reserveManualFinance } from '../src/finance-manual.js';
import { assertFinanceDayAvailable } from '../scripts/check_finance_daily_limit.js';
import { sendFinanceFailure } from '../scripts/notify_finance_failure.js';
import { postToTelegram } from '../src/telegram.js';

const bundle = (more = {}) => ({ version: 1, runId: '321', publicationStarted: false, drafts: [{ title: 'Сохранённая статья', bodyHtml: '<p>Точный сохранённый текст.</p>', issues: ['Нужна проверка факта'], passedReview: false,
  source: { topicId: 'budget-1', topicGroup: 'budget', currentDate: '2026-10-19', references: [{ label: 'Официальный источник', url: 'https://sfr.gov.ru/test' }] } }], ...more });
const request = html => ({ fileId: 'fake_file', runId: '321', index: 0, sha256: createHash('sha256').update(html).digest('hex'), requestId: 'a'.repeat(32), date: '2026-10-19', testRun: false });

test('manual publication uses the exact saved body with normal CTA and source links, without a model', () => {
  const html = renderFinanceDraftDocument(bundle()), input = request(html);
  const draft = readConfirmedDraft(html, input);
  const article = buildSavedFinanceArticle(draft, input, { channelName: 'Финансовые будни', cta: { subscriptionMode: 'habit' } }, { channelUrl: 'https://t.me/finanbudni' });
  assert.equal(article.bodyHtml, draft.bodyHtml);
  assert.match(article.html, /Чтобы не пропустить/);
  assert.match(article.html, /https:\/\/sfr.gov.ru\/test/);
  assert.equal(article.source.manualOverride.sourceRunId, '321');
  assert.deepEqual(article.source.manualOverride.rejectedIssues, ['Нужна проверка факта']);
});

test('tampered documents, wrong run, partially published and old documents cannot be published', () => {
  const html = renderFinanceDraftDocument(bundle()), input = request(html);
  assert.throws(() => readConfirmedDraft(html + 'changed', input), /не совпал/);
  assert.throws(() => readConfirmedDraft(html, { ...input, runId: '999' }), /другого запуска/);
  for (const publicationStarted of [true, undefined]) {
    const file = renderFinanceDraftDocument(bundle({ publicationStarted }));
    assert.throws(() => readConfirmedDraft(file, request(file)), /уже мог начать/);
  }
  assert.throws(() => validateManualRequest({ ...input, runId: '../x' }));
  assert.throws(() => validateManualRequest({ ...input, index: '0' }));
});

test('a technical test document can never become a public publication', async () => {
  const html = renderFinanceDraftDocument(bundle({ testOnly: true }));
  assert.throws(() => readConfirmedDraft(html, request(html)), /Тестовый/);
  assert.ok(readConfirmedDraft(html, { ...request(html), testRun: true }));
  const real = renderFinanceDraftDocument(bundle());
  assert.throws(() => readConfirmedDraft(real, { ...request(real), testRun: true }), /Тестовый/);
});

test('test notification stamps the attached document as test-only', async () => {
  await sendFinanceFailure({ token: 'fake', chatId: '123', draftBundle: bundle(), testMode: true, fetchImpl: async (_url, options) => {
    const html = await options.body.get('document').text();
    assert.ok(readConfirmedDraft(html, { ...request(html), testRun: true }));
    return { ok: true, json: async () => ({ ok: true }) };
  } });
});

test('draft recorder persists the public-side-effect marker atomically', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-marker-'));
  try {
    const file = path.join(dir, 'draft.json'), record = createFinanceDraftRecorder({ file, runId: '321' });
    await record({}, { title: 'Текст', bodyHtml: '<p>Текст</p>' }, ['Отклонён']);
    assert.equal(JSON.parse(await readFile(file)).publicationStarted, false);
    await record.markPublicationStarted();
    assert.equal(JSON.parse(await readFile(file)).publicationStarted, true);
  } finally { await rm(dir, { recursive: true }); }
});

test('durable reservation blocks a second manual/automatic release and the same draft on another day', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-reserve-'));
  try {
    await writeFile(path.join(dir, 'posts.json'), '[]');
    const html = renderFinanceDraftDocument(bundle()), input = request(html), article = { title: 'Тест', bodyHtml: '<p>Текст</p>' };
    const state = await reserveManualFinance(dir, input, article, new Date('2026-10-19T16:00:00Z'));
    assert.equal(state.status, 'reserved');
    await assert.rejects(assertFinanceDayAvailable(dir, [], new Date('2026-10-19T20:59:00Z')), /зарезервирован/);
    await assert.rejects(reserveManualFinance(dir, input, article, new Date('2026-10-19T16:01:00Z')), /зарезервирован/);
    await assert.rejects(reserveManualFinance(dir, { ...input, date: '2026-10-20' }, article, new Date('2026-10-20T16:00:00Z')), /уже отправлялся/);
    await assert.rejects(reserveManualFinance(dir, input, article, new Date('2026-10-20T16:00:00Z')), /Дата/);
    await assert.rejects(reserveManualFinance(dir, { ...input, testRun: true }, article), /Тест/);
  } finally { await rm(dir, { recursive: true }); }
});

test('an existing publication or identical title blocks manual release before images and sends', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-existing-'));
  try {
    const html = renderFinanceDraftDocument(bundle()), input = request(html);
    await writeFile(path.join(dir, 'posts.json'), JSON.stringify([{ title: 'Ранее', date: '2026-10-19T16:10:00Z' }]));
    await assert.rejects(reserveManualFinance(dir, input, { title: 'Тест' }, new Date('2026-10-19T16:11:00Z')), /уже опубликована/);
    await writeFile(path.join(dir, 'posts.json'), JSON.stringify([{ title: 'Тест', date: '2026-10-18T16:10:00Z' }]));
    await assert.rejects(reserveManualFinance(dir, input, { title: 'Тест' }, new Date('2026-10-19T16:11:00Z')), /уже опубликован/);
  } finally { await rm(dir, { recursive: true }); }
});

test('manual Telegram send never falls back after an uncertain result, even without a cover', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Ambiguous timeout'); });
  await assert.rejects(postToTelegram({ title: 'Тест', html: '<p>Текст</p>' }, null, { botToken: 'fake', channelId: '@fake' }, { noFallback: true }));
  assert.equal(calls, 1);
});
