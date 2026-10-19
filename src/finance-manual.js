import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { parseArticle } from './prompt.js';
import { appendFinanceReferences } from './finance-review.js';
import { renderFinanceDraftDocument } from './finance-drafts.js';
import { toPlainText } from './sanitize.js';
import { financeDateKey, assertFinanceDayAvailable } from '../scripts/check_finance_daily_limit.js';

export function validateManualRequest(input) {
  if (!input || !/^[A-Za-z0-9_-]{1,256}$/.test(input.fileId || '') || !/^\d{1,20}$/.test(input.runId || '')
    || ![0, 1].includes(input.index) || !/^[a-f0-9]{64}$/.test(input.sha256 || '')
    || !/^[a-f0-9]{32}$/.test(input.requestId || '') || !/^\d{4}-\d{2}-\d{2}$/.test(input.date || '')
    || typeof input.testRun !== 'boolean') throw new Error('Некорректное подтверждение публикации.');
  return input;
}

export function readConfirmedDraft(html, input) {
  validateManualRequest(input);
  if (Buffer.byteLength(html, 'utf8') > 262144 || createHash('sha256').update(html).digest('hex') !== input.sha256) throw new Error('Сохранённый текст не совпал с подтверждённым файлом.');
  const payload = html.match(/<script type="application\/json" id="finance-draft-data">([\s\S]*?)<\/script>/)?.[1];
  if (!payload) throw new Error('Нет сохранённого текста.');
  const bundle = JSON.parse(payload);
  renderFinanceDraftDocument(bundle); // Same strict schema/sanitizer as the private alert.
  if (String(bundle.runId) !== input.runId || !bundle.drafts[input.index]) throw new Error('Черновик другого запуска.');
  if (bundle.publicationStarted !== false) throw new Error('Прошлый запуск уже мог начать публикацию. Нужна ручная проверка, чтобы не создать дубль.');
  if (input.testRun !== (bundle.testOnly === true)) throw new Error('Тестовый документ нельзя публиковать публично.');
  // Parse the whitelisted, sanitized representation, not arbitrary fields in an attachment.
  const safe = JSON.parse(renderFinanceDraftDocument(bundle).match(/id="finance-draft-data">([\s\S]*?)<\/script>/)[1]);
  return safe.drafts[input.index];
}

export function buildSavedFinanceArticle(draft, input, niche, target) {
  // NO generateArticle, review or text-model call on the manual publication path.
  const article = parseArticle(JSON.stringify({ title: draft.title, html: draft.bodyHtml,
    tags: draft.tags, image_queries: draft.imageQueries }), {
    channelUrl: target.channelUrl, channelName: niche.channelName, topicLabel: niche.topicLabel, ...(niche.cta || {}),
  });
  appendFinanceReferences(article, { factualSources: draft.source?.references || [], currentDate: draft.source?.currentDate || '' });
  article.source = { ...draft.source, niche: 'finance', publicationSlot: 'manual', selectedAt: new Date().toISOString(),
    manualOverride: { sourceRunId: input.runId, draftIndex: input.index, requestId: input.requestId, rejectedIssueCount: draft.issues.length, confirmedDate: input.date } };
  return article;
}

export async function reserveManualFinance(dir, input, article, now = new Date()) {
  validateManualRequest(input);
  if (input.testRun) throw new Error('Тест не может резервировать публикацию.');
  if (financeDateKey(now) !== input.date) throw new Error('Дата подтверждения уже прошла. Нажмите «Публикация» заново.');
  const posts = JSON.parse(await readFile(path.join(dir, 'posts.json'), 'utf8'));
  await assertFinanceDayAvailable(dir, posts, now);
  const normalize = value => toPlainText(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  const body = normalize(article.bodyHtml);
  if (posts.some(post => normalize(post.title) === normalize(article.title)
    || (body.length > 100 && normalize(post.html).includes(body)))) throw new Error('Такой текст или заголовок уже опубликован.');
  const key = `${input.runId}-${input.index}`;
  const root = path.join(dir, '.finance-manual-publish');
  try { await access(path.join(root, 'drafts', `${key}.json`)); throw new Error('Этот черновик уже отправлялся на публикацию. Проверьте результат, повтор запрещён.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const state = { version: 1, date: input.date, draftKey: key, requestId: input.requestId, sha256: input.sha256, status: 'reserved', reservedAt: now.toISOString() };
  await saveManualFinanceState(dir, state);
  return state;
}

export async function saveManualFinanceState(dir, state) {
  for (const [group, key] of [['dates', state.date], ['drafts', state.draftKey]]) {
    const folder = path.join(dir, '.finance-manual-publish', group);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, `${key}.json`), JSON.stringify(state, null, 2), 'utf8');
  }
}
