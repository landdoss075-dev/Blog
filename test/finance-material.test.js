import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FINANCE_MATERIAL_INDEXES, isFinanceMaterialUrl, parseFinanceMaterialIndex, parseFinanceMaterial, discoverFinanceMaterial, isRepeatedFinanceMaterial } from '../src/finance-material.js';
import { selectFinanceTopic } from '../src/finance-selection.js';
import { prepareFinanceEvidence } from '../src/finance-reader.js';
import { loadFinanceSources, reviewFinanceArticle } from '../src/finance-review.js';
import { generateFinanceWithFallback } from '../src/finance-generation.js';
import { buildMessages, buildRevisionMessages, selectDistinctTitle } from '../src/prompt.js';
import { niches } from '../src/niches.js';

const now = new Date('2026-10-31T12:00:00Z');
const url = 'https://sfr.gov.ru/press_center/news/~2026/10/30/123456';
const title = 'Доплата к пенсии изменилась: какие суммы проверить';
const text = 'Условия назначения выплаты зависят от подтверждённых сведений и категории получателя. Размер следует рассматривать вместе с основаниями расчёта. '.repeat(7);
const html = (heading = title, content = text, date = '2026-10-30T09:00:00+03:00') => `<meta itemprop="datePublished" content="${date}"><h1>${heading}</h1><div itemprop="articleBody"><div><p>${content}</p></div></div><footer>НЕ ИСТОЧНИК</footer>`;
const index = entries => entries.map(([link, heading]) => `<a href="${link}"><h3>${heading}</h3></a>`).join('');
const response = body => ({ ok: true, text: async () => body });
const material = () => parseFinanceMaterial(html(), { url, title }, now);

test('only exact HTTPS official article paths are allowed, never credentials, query, port or redirects', () => {
  assert.equal(isFinanceMaterialUrl(url), true);
  assert.equal(isFinanceMaterialUrl('https://www.nalog.gov.ru/rn77/news/activities_fts/123456/'), true);
  for (const unsafe of ['http://sfr.gov.ru/press_center/news/~2026/10/30/123456', `${url}?redirect=http://localhost`, `${url}#x`, url.replace('sfr.gov.ru', 'sfr.gov.ru.evil.test'), url.replace('sfr.gov.ru', 'user:password@sfr.gov.ru'), url.replace('sfr.gov.ru', 'sfr.gov.ru:8080'), 'https://127.0.0.1/test', 'https://sfr.gov.ru/files/test', 'https://www.nalog.gov.ru/rn77/news/activities_fts/123456/print/']) {
    assert.equal(isFinanceMaterialUrl(unsafe), false, unsafe);
  }
});

test('official index parser accepts text links and nested headings, not image-only or foreign links', () => {
  const body = `<a href="${url}"><img src="x"></a>` + index([[url, title], [url, title], ['https://evil.test/article', title], ['/press_center/news/', title]]);
  const result = parseFinanceMaterialIndex(body, FINANCE_MATERIAL_INDEXES[0]);
  assert.deepEqual(result, [{ url, title }]);
  assert.deepEqual(parseFinanceMaterialIndex(body, 'https://evil.test/'), []);
});

test('article extraction keeps complete nested body, actual title/date and no footer', () => {
  const source = material();
  assert.ok(source.text.includes('Условия назначения'));
  assert.doesNotMatch(source.text, /НЕ ИСТОЧНИК/);
  assert.equal(source.kind, 'official-material');
  assert.equal(source.publishedAt, '2026-10-30T06:00:00.000Z');
  assert.equal(source.checkedAt, now.toISOString());
});

test('stale, future, missing-content and mismatched pages cannot become evidence', () => {
  for (const body of [html(title, text, '2026-09-01T09:00:00Z'), html(title, text, '2026-11-01T09:00:00Z'), html('Другая страница'), html(title, 'слишком коротко'), `<h1>${title}</h1><p>${text}</p>`, html(title, text.repeat(20))]) {
    assert.equal(parseFinanceMaterial(body, { url, title }, now), null);
  }
});

test('FNS visible date and text_block layout work without trusting hidden archive notice', () => {
  const candidate = { url: 'https://www.nalog.gov.ru/rn77/news/activities_fts/123456/', title };
  const body = `<h1>${title}</h1><div class="text_block"><div>Дата публикации: 30.10.2026 10:00</div><div class="attention attention_red" style="display: none"><div class="attention__text"><p>Архивная публикация</p></div></div><p>${text}</p></div>`;
  const source = parseFinanceMaterial(body, candidate, now);
  assert.ok(source);
  assert.equal(source.publishedAt, '2026-10-30T07:00:00.000Z');
  assert.doesNotMatch(source.text, /Архивная публикация/);
  assert.equal(parseFinanceMaterial(body.replace('30.10.2026 10:00', 'дата неизвестна'), candidate, now), null);
});

test('repeats include original URL, differently worded same subject and weekly capremont cooldown', () => {
  assert.equal(isRepeatedFinanceMaterial({ url, title }, [{ source: { references: [{ url }] } }], now), true);
  assert.equal(isRepeatedFinanceMaterial({ url, title }, [{ title: 'Какие суммы проверить: доплата к пенсии изменилась' }], now), true);
  assert.equal(isRepeatedFinanceMaterial({ url, title: 'Компенсация капремонта: что проверить в платеже' }, [{ title: 'Другая льгота на капремонт', date: '2026-10-29T09:00:00Z' }], now), true);
});

test('discovery reads bounded candidates on allowed URLs with redirects disabled, no model', async () => {
  const calls = [];
  const result = await discoverFinanceMaterial(niches.finance, { now, fetchImpl: async (target, options) => {
    calls.push(target);
    assert.equal(options.redirect, 'error');
    if (target === FINANCE_MATERIAL_INDEXES[0]) return response(index(Array.from({ length: 8 }, (_, i) => [url.replace('123456', String(123456 + i)), `${title} ${i}`])));
    if (target === FINANCE_MATERIAL_INDEXES[1]) return response('');
    return response(html(`${title} ${Number(target.match(/\d+$/)[0]) - 123456}`));
  } });
  assert.equal(calls.length, 6); // two indexes + at most four articles
  assert.equal(result.materialSelection.basis, 'read-official-material');
  assert.equal(result.materialSelection.readerValue.factsVerified, false);
  assert.equal(result.topicScore, null); // do not counterfeit the old trend score
  assert.equal(result.primaryMaterial.url, result.sourceUrl);
});

test('discovery cannot bypass a repeated subject or two consecutive group publications', async () => {
  const result = await discoverFinanceMaterial(niches.finance, { now,
    recentPosts: [{ title: 'Сельский стаж', source: { topicGroup: 'pension' } }, { title: 'Банковские реквизиты', source: { topicGroup: 'pension' } }],
    fetchImpl: async target => response(FINANCE_MATERIAL_INDEXES.includes(target) ? index([[url, title]]) : html()),
  });
  assert.equal(result, null);
});

test('an official budget bill with money keywords is not mistaken for a concrete reader question', async () => {
  let articlesRead = 0;
  const heading = 'Госдума приняла в первом чтении проект бюджета Соцфонда на 2027 год';
  const result = await discoverFinanceMaterial(niches.finance, { now, fetchImpl: async target => {
    if (FINANCE_MATERIAL_INDEXES.includes(target)) return response(index([[url, heading]]));
    articlesRead++;
    return response(html(heading));
  } });
  assert.equal(result, null);
  assert.equal(articlesRead, 0);
});

test('failed indexes, changed layout and oversized replies fail softly to the existing pipeline', async () => {
  assert.equal(await discoverFinanceMaterial(niches.finance, { fetchImpl: async () => { throw new Error('timeout'); } }), null);
  assert.equal(await discoverFinanceMaterial(niches.finance, { fetchImpl: async () => response('x'.repeat(1500001)) }), null);
  const result = await selectFinanceTopic(niches.finance, { now, recentPosts: [], discoverMaterial: async () => null, fetchFeed: async () => [] });
  assert.equal(result.topicOrigin, 'editorial');
  assert.ok(result.topicId);
});

test('source-first selection precedes Google headlines and preserves recent formats/context', async () => {
  const result = await selectFinanceTopic(niches.finance, { now,
    recentPosts: [{ title: 'Предыдущая статья', source: { presentationFormat: 'check' } }],
    discoverMaterial: async () => ({ headline: title, sourceUrl: url, primaryMaterial: material() }),
    fetchFeed: async () => { throw new Error('Google is not needed'); },
  });
  assert.equal(result.headline, title);
  assert.deepEqual(result.recentFormats, ['check']);
  const fallback = await selectFinanceTopic(niches.finance, { now, recentPosts: [], editorialFallback: true,
    discoverMaterial: async () => { throw new Error('Must not rediscover on fallback'); },
  });
  assert.equal(fallback.selectionReason, 'review-fallback');
});

test('background source failures do not discard the already-read specific official material', async () => {
  const found = await loadFinanceSources({ topicGroup: 'pension', headline: title, sourceUrl: url, primaryMaterial: material() }, async () => { throw new Error('offline'); });
  assert.equal(found.length, 1);
  assert.equal(found[0].url, url);
  const unsafe = await loadFinanceSources({ topicGroup: 'budget', sourceUrl: 'https://evil.test/', primaryMaterial: { ...material(), url: 'https://evil.test/' } }, async () => { throw new Error('Must not fetch this'); });
  assert.deepEqual(unsafe, []);
});

test('a high-rated headline alone falls back before any paid draft is requested', async () => {
  let drafts = 0;
  const result = await generateFinanceWithFallback({ headline: title, topicOrigin: 'news', topicGroup: 'pension' }, {
    loadSources: async () => [{ url: 'https://sfr.gov.ru/reference', text }],
    selectFallback: async () => ({ headline: 'Расходы до зарплаты', topicGroup: 'budget', topicOrigin: 'editorial' }),
    generate: async topic => { drafts++; assert.equal(topic.evidenceBrief.basis, 'conditional-budget-example'); return { title: 'Бюджет' }; },
  });
  assert.equal(drafts, 1);
  assert.equal(result.attemptCount, 2);
});

test('formats rotate without cloning myths or real cases, evidence brief reaches draft/revision/editor', async () => {
  const recentFormats = [];
  for (let i = 0; i < 7; i++) {
    const topic = prepareFinanceEvidence({ strictFinance: true, headline: title, theme: title, topicGroup: 'pension', recentFormats: [...recentFormats], factualSources: [material()], sourceUrl: url });
    assert.notEqual(topic.presentationFormat, recentFormats[0]);
    recentFormats.unshift(topic.presentationFormat);
    recentFormats.splice(5);
    assert.doesNotMatch(topic.editorialFormat, /разбор мифа|личная история/);
    assert.equal(topic.evidenceBrief.basis, 'read-official-material');
    const messages = buildMessages(topic);
    assert.match(messages[1].content, /read-official-material/);
    assert.doesNotMatch(messages[1].content, /Самый популярный новостной повод/);
    assert.match(buildRevisionMessages({ titleVariants: [], bodyHtml: '<p>Текст</p>' }, ['Исправь'], topic)[1].content, /read-official-material/);
    await reviewFinanceArticle({ title, bodyHtml: '<p>Условный пример.</p>' }, topic, async messages => {
      assert.equal(JSON.parse(messages.at(-1).content).readerContract.evidence.primaryUrl, url);
      return JSON.stringify({ onTopic: true, titleMatches: true, useful: true, distinct: true, factsSupported: true, issues: [], claims: [] });
    });
  }
  assert.equal(new Set(recentFormats).size, 3);
});

test('reference card never describes a general page as a new event and prompts do not require engagement bait', () => {
  const topic = prepareFinanceEvidence({ strictFinance: true, topicOrigin: 'editorial', headline: title, theme: title, topicGroup: 'pension', factualSources: [{ url: 'https://sfr.gov.ru/reference', label: 'Справка', text }] });
  assert.equal(topic.evidenceBrief.basis, 'reference-explanation');
  assert.equal(topic.evidenceBrief.publishedAt, null);
  assert.match(topic.evidenceBrief.limits, /не свежая новость/);
  const messages = buildMessages({ ...topic, promptGuidance: niches.finance.promptGuidance });
  assert.doesNotMatch(messages.map(m => m.content).join('\n'), /чтобы спровоцировать комментарии/);
  assert.match(messages[0].content, /Вопрос читателю необязателен/);
});

test('budget format metadata changes the actual prompt without importing legal-service comparisons', () => {
  const base = { strictFinance: true, topicOrigin: 'editorial', headline: 'Расходы до зарплаты', theme: 'Расходы до зарплаты', topicGroup: 'budget', factualSources: [] };
  const first = prepareFinanceEvidence({ ...base, recentFormats: [] });
  const second = prepareFinanceEvidence({ ...base, recentFormats: [first.presentationFormat] });
  const third = prepareFinanceEvidence({ ...base, recentFormats: [second.presentationFormat, first.presentationFormat] });
  const prompts = [first, second, third].map(topic => buildMessages(topic)[1].content);
  assert.equal(new Set([first.presentationFormat, second.presentationFormat, third.presentationFormat]).size, 3);
  assert.match(prompts.join('\n'), /сопоставь два варианта расходов/);
  assert.match(prompts.join('\n'), /покажи проверку своего списка расходов/);
  for (const prompt of prompts) assert.match(prompt, /без правовых советов и сравнения ведомств/);
});

test('the final title keeps an understandable reader problem instead of an abstract billing mechanism', () => {
  const article = { titleVariants: ['Норматив вместо факта: сравнение двух оснований платы за воду', 'Показания счётчика не приняли: как проверить расчёт за воду'] };
  selectDistinctTitle(article, [], { strictFinance: true });
  assert.equal(article.title, article.titleVariants[1]);
});

test('production and preview use the same selection/generation and do not alter publication infrastructure', async () => {
  for (const file of ['../scripts/generate_and_post.js', '../scripts/preview_finance.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /await selectFinanceTopic\(niche/);
    assert.match(source, /await generateFinanceWithFallback\(/);
  }
  const source = await readFile(new URL('../scripts/generate_and_post.js', import.meta.url), 'utf8');
  assert.match(source, /materialSelection: topic.materialSelection/);
  assert.match(source, /presentationFormat: topic.presentationFormat/);
  assert.doesNotMatch(source.slice(source.indexOf('article.source ='), source.indexOf('// 3. Картинки')), /primaryMaterial:|evidenceBrief:/);
});
