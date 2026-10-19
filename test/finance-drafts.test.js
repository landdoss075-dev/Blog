import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createFinanceDraftRecorder, renderFinanceDraftDocument } from '../src/finance-drafts.js';
import { sendFinanceFailure } from '../scripts/notify_finance_failure.js';
import { generateArticle } from '../src/llm.js';

const bundle = () => ({ version: 1, runId: '12345', drafts: [{ title: 'Заголовок', bodyHtml: '<p>Текст.</p>', issues: ['Не хватает источника'], passedReview: false }] });

test('draft recorder preserves the latest candidate for each of at most two topics', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'finance-drafts-test-'));
  try {
    const file = path.join(dir, 'drafts.json');
    const record = createFinanceDraftRecorder({ file, runId: '12345' });
    await record({ topicId: 'a' }, { title: 'Первая', bodyHtml: '<p>Текст</p>' }, ['Коротко']);
    await record({ topicId: 'a' }, { title: 'Редактура', bodyHtml: '<p>Доработанный текст</p>' }, ['Нет источника']);
    await record({ topicId: 'b' }, { title: 'Вторая тема', bodyHtml: '<p>Другой текст</p>' }, []);
    await record({ topicId: 'c' }, { title: 'Лишняя', bodyHtml: '<p>Текст</p>' }, []);
    const saved = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(saved.drafts.length, 2);
    assert.equal(saved.drafts[0].title, 'Редактура');
    assert.equal(saved.drafts[0].passedReview, false);
    assert.equal(saved.drafts[1].passedReview, true);
  } finally { await rm(dir, { recursive: true }); }
});

test('draft document cannot execute model HTML or close its embedded JSON script', () => {
  const data = bundle();
  data.drafts[0].title = '</script><img src=x onerror=alert(1)>';
  data.drafts[0].bodyHtml = '<p onclick="alert(1)">Текст</p><script>alert(1)</script>';
  const html = renderFinanceDraftDocument(data);
  assert.ok(!html.includes('onclick='));
  assert.ok(!html.includes('<img src=x'));
  const payload = JSON.parse(html.match(/id="finance-draft-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(payload.drafts[0].title, data.drafts[0].title);
});

test('failure alert attaches a private document and a preview-only callback, with no publishing button', async () => {
  await sendFinanceFailure({ token: 'fake', chatId: '123', runUrl: 'https://github.com/test', draftBundle: bundle(), fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sendDocument'));
    assert.equal(options.body.get('chat_id'), '123');
    const keyboard = JSON.parse(options.body.get('reply_markup'));
    assert.equal(keyboard.inline_keyboard[0][0].callback_data, 'finance_draft_view:0');
    assert.equal(options.body.get('document').name, 'finance-drafts-12345.html');
    assert.ok(options.body.get('caption').includes('личном чате'));
    return { ok: true, json: async () => ({ ok: true, result: { message_id: 1 } }) };
  } });
});

test('invalid draft data cannot suppress the failure alert', async () => {
  await sendFinanceFailure({ token: 'fake', chatId: '123', runUrl: 'https://github.com/test', draftBundle: { version: 99, drafts: [{}] }, fetchImpl: async (url, options) => {
    assert.ok(url.endsWith('/sendMessage'));
    assert.ok(!JSON.parse(options.body).reply_markup);
    return { ok: true, json: async () => ({ ok: true }) };
  } });
});

test('a parsed candidate is retained even when the independent editor crashes', async () => {
  let saved;
  let calls = 0;
  const candidate = { titles: ['Один', 'Два', 'Три', 'Четыре', 'Пять', 'Шесть', 'Семь'], html: '<p>Текст.</p>' };
  await assert.rejects(generateArticle({ strictFinance: true, minWords: 1, minChars: 1, headlines: [], headline: 'Тест', theme: 'Тест' }, {
    name: 'test', provider: { model: () => 'test', call: async () => { if (++calls === 1) return JSON.stringify(candidate); throw new Error('Editor unavailable'); } },
    onCandidate: async (article, issues) => { saved = { article, issues }; },
  }), /Editor unavailable/);
  assert.ok(saved.article.bodyHtml.includes('Текст'));
  assert.ok(saved.issues.some(issue => issue.includes('Проверка не завершена')));
});
