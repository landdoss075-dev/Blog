import { mkdir, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeHtml } from './sanitize.js';

export const FINANCE_DRAFT_FILE = 'out/finance-drafts.json';
const escape = value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function createFinanceDraftRecorder({ file = FINANCE_DRAFT_FILE, runId = process.env.GITHUB_RUN_ID || 'manual' } = {}) {
  const drafts = new Map();
  let publicationStarted = false;
  const persist = async () => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify({ version: 1, runId: String(runId), publicationStarted, savedAt: new Date().toISOString(), drafts: [...drafts.values()] }), 'utf8');
    await rename(`${file}.tmp`, file);
  };
  const record = async (topic, article, issues = []) => {
    const bodyHtml = article.bodyHtml || article.html;
    if (!bodyHtml || !article.title) return;
    const key = topic.topicId || topic.headline || topic.theme;
    if (!drafts.has(key) && drafts.size >= 2) return;
    drafts.set(key, {
      title: String(article.title).slice(0, 200), bodyHtml: sanitizeHtml(bodyHtml).slice(0, 100000),
      assignment: String(topic.headline || topic.theme || '').slice(0, 300),
      issues: issues.filter(issue => typeof issue === 'string').slice(0, 8).map(issue => issue.slice(0, 1500)),
      passedReview: issues.length === 0, words: article.bodyWords || 0,
      imageQueries: article.image_queries || [], tags: article.tags || [],
      source: {
        topicId: topic.topicId || '', topicGroup: topic.topicGroup || '',
        headline: topic.headline || topic.theme || '', topicOrigin: topic.topicOrigin || 'editorial',
        currentDate: topic.currentDate || '',
        references: (topic.factualSources || []).map(({ label, url, checkedAt }) => ({ label, url, checkedAt })),
      },
    });
    await persist();
  };
  // Unlike candidate snapshots this must fail closed before any public side effect.
  record.markPublicationStarted = async () => { publicationStarted = true; await persist(); };
  return record;
}

function draftMetadata(draft) {
  const strings = (list, max, length) => Array.isArray(list) ? list.filter(value => typeof value === 'string').slice(0, max).map(value => value.slice(0, length)) : [];
  const source = draft.source || {};
  return {
    imageQueries: strings(draft.imageQueries, 3, 150), tags: strings(draft.tags, 10, 80),
    source: Object.fromEntries(['topicId', 'topicGroup', 'headline', 'topicOrigin', 'currentDate'].map(key => [key, String(source[key] || '').slice(0, 300)]).concat([['references',
      (Array.isArray(source.references) ? source.references : []).slice(0, 8).filter(ref => {
        try { const url = new URL(ref.url); return url.protocol === 'https:' && !url.username && !url.password; } catch { return false; }
      }).map(ref => ({ label: String(ref.label || '').slice(0, 200), url: ref.url.slice(0, 2000), checkedAt: String(ref.checkedAt || '').slice(0, 50) })),
    ]])),
  };
}

export function renderFinanceDraftDocument(bundle) {
  if (bundle?.version !== 1 || !/^\d+$/.test(bundle.runId) || !Array.isArray(bundle.drafts)
    || !bundle.drafts.length || bundle.drafts.length > 2) throw new Error('Некорректный пакет черновиков.');
  for (const draft of bundle.drafts) {
    if (typeof draft.title !== 'string' || !draft.title.trim() || draft.title.length > 200 || typeof draft.bodyHtml !== 'string'
      || !draft.bodyHtml.trim() || draft.bodyHtml.length > 100000 || !Array.isArray(draft.issues) || draft.issues.length > 8
      || draft.issues.some(issue => typeof issue !== 'string' || issue.length > 1500)
      || typeof draft.passedReview !== 'boolean') throw new Error('Некорректный черновик.');
  }
  const safeBundle = { version: 1, runId: String(bundle.runId), publicationStarted: bundle.publicationStarted,
    testOnly: bundle.testOnly === true, drafts: bundle.drafts.map(draft => ({
    title: draft.title, bodyHtml: sanitizeHtml(draft.bodyHtml), issues: draft.issues, passedReview: draft.passedReview,
    ...draftMetadata(draft),
  })) };
  const payload = JSON.stringify(safeBundle).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><title>Личные черновики — не опубликовано</title><body style="max-width:760px;margin:30px auto;font:18px/1.6 sans-serif;padding:15px"><h1>Черновики для личного просмотра</h1><p>Это НЕ публикация в канале, на сайте или в RSS. Проверка могла выявить ошибки. Не воспринимайте текст как проверенную инструкцию.</p>${safeBundle.drafts.map((draft, i) => `<section><h2>Черновик ${i + 1}: ${escape(draft.title)}</h2><p>${draft.passedReview ? 'Текст прошёл проверку, но запуск публикации завершился с ошибкой.' : 'Текст не прошёл автоматическую проверку.'}</p><ul>${draft.issues.map(issue => `<li>${escape(issue)}</li>`).join('')}</ul>${draft.bodyHtml}</section>`).join('')}<script type="application/json" id="finance-draft-data">${payload}</script></body></html>`;
  if (Buffer.byteLength(html, 'utf8') > 262144) throw new Error('Пакет черновиков превышает лимит размера.');
  return html;
}
