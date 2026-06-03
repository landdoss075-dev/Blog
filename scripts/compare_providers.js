import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { log } from '../src/log.js';
import { fetchTopic } from '../src/news.js';
import { buildMessages, parseArticle } from '../src/prompt.js';
import { callGroq } from '../src/groq.js';
import { callOpenAI } from '../src/openai.js';

/**
 * Сравнение провайдеров: берёт ОДНУ горячую тему дня и генерирует статью
 * и на Groq (Llama), и на OpenAI (GPT). Кладёт обе версии рядом для сравнения.
 *
 * Запуск: npm run compare
 * Нужны оба ключа: GROQ_API_KEY и OPENAI_API_KEY.
 */
async function main() {
  log.step('Сравнение провайдеров на одной теме');

  const candidates = [
    { name: 'groq', model: config.groq.model, call: callGroq, key: config.groq.apiKey },
    { name: 'openai', model: config.openai.model, call: callOpenAI, key: config.openai.apiKey },
  ].filter((p) => {
    if (!p.key) log.warn(`Пропускаю ${p.name}: нет API-ключа.`);
    return p.key;
  });

  if (candidates.length === 0) {
    throw new Error('Нет ни одного ключа (GROQ_API_KEY / OPENAI_API_KEY).');
  }

  log.step('Тема дня (одна для всех)');
  const topic = await fetchTopic();
  const messages = buildMessages(topic);

  const results = [];
  for (const p of candidates) {
    log.step(`Генерация: ${p.name} (${p.model})`);
    const started = Date.now();
    try {
      const article = parseArticle(await p.call(messages));
      const ms = Date.now() - started;
      log.ok(`${p.name}: «${article.title}» за ${(ms / 1000).toFixed(1)}с`);
      results.push({ provider: p.name, model: p.model, ms, article });
    } catch (err) {
      log.error(`${p.name}: ${err.message}`);
      results.push({ provider: p.name, model: p.model, error: err.message });
    }
  }

  await save(topic, results);
}

async function save(topic, results) {
  const dir = path.resolve('out');
  await mkdir(dir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');

  await writeFile(
    path.join(dir, `compare-${ts}.json`),
    JSON.stringify({ topic, results }, null, 2),
    'utf8',
  );

  const blocks = results
    .map((r) => {
      if (r.error) {
        return `<section><h2>${r.provider} (${r.model})</h2><p style="color:red">Ошибка: ${r.error}</p></section>`;
      }
      const a = r.article;
      const words = a.html.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
      return `<section style="border-top:2px solid #ddd;padding-top:16px">
  <h2>${r.provider} <small style="color:#888">(${r.model}, ${(r.ms / 1000).toFixed(1)}с, ~${words} слов)</small></h2>
  <h3>${a.title}</h3>
  ${a.html}
  <details><summary>Версия для Telegram</summary><pre style="white-space:pre-wrap">${a.telegram}</pre></details>
  <p><b>Теги:</b> ${a.tags.join(', ')}</p>
</section>`;
    })
    .join('\n');

  const html = `<!doctype html><meta charset="utf-8">
<title>Сравнение провайдеров</title>
<body style="max-width:760px;margin:40px auto;font:17px/1.6 system-ui;padding:0 16px">
<h1>Сравнение: одна тема, разные модели</h1>
<p style="color:#666"><b>Повод:</b> ${topic.headline}<br><b>Тренды:</b> ${topic.trendKeywords.join(', ')}</p>
${blocks}
</body>`;
  await writeFile(path.join(dir, `compare-${ts}.html`), html, 'utf8');

  log.ok(`Готово. Открой out/compare-${ts}.html для сравнения бок о бок.`);
}

main().catch((err) => {
  log.error(err.stack || err.message);
  process.exit(1);
});
