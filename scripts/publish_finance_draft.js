import { execFileSync } from 'node:child_process';
import { writeFile, readFile } from 'node:fs/promises';
import { validateManualRequest, readConfirmedDraft, buildSavedFinanceArticle, reserveManualFinance, saveManualFinanceState } from '../src/finance-manual.js';
import { financeDateKey } from './check_finance_daily_limit.js';
import { getNiche, resolveSite, resolveTelegram } from '../src/niches.js';

const API = 'https://api.telegram.org';
async function telegram(method, data) {
  try {
    const response = await fetch(`${API}/bot${process.env.FINANCE_ALERT_BOT_TOKEN}/${method}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data), signal: AbortSignal.timeout(20000),
    });
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error();
    return json.result;
  } catch { throw new Error('Не удалось обратиться к Telegram для сохранённого черновика.'); }
}

export async function downloadSavedDraft(fileId) {
  const file = await telegram('getFile', { file_id: fileId });
  if (!file.file_size || file.file_size > 262144 || !/^[A-Za-z0-9_./-]+$/.test(file.file_path || '') || file.file_path.split('/').includes('..')) throw new Error('Недопустимый файл черновика.');
  try {
    const response = await fetch(`${API}/file/bot${process.env.FINANCE_ALERT_BOT_TOKEN}/${file.file_path}`, { signal: AbortSignal.timeout(20000), redirect: 'error' });
    if (!response.ok || Number(response.headers.get('content-length')) > 262144 || !response.body) throw new Error();
    const parts = []; let bytes = 0;
    for await (const part of response.body) { bytes += part.length; if (bytes > 262144) throw new Error(); parts.push(part); }
    return Buffer.concat(parts).toString('utf8');
  } catch { throw new Error('Не удалось скачать сохранённый черновик.'); }
}

async function verifySourceRun(input) {
  if (input.testRun) return;
  const response = await fetch(`https://api.github.com/repos/landdoss075-dev/Blog/actions/runs/${input.runId}`, {
    headers: { Authorization: `Bearer ${process.env.GITHUB_TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) throw new Error('Не удалось проверить исходный запуск.');
  const run = await response.json();
  if (run.path !== '.github/workflows/daily_finance_post.yml' || run.status !== 'completed' || run.conclusion !== 'failure'
    || run.repository?.full_name !== 'landdoss075-dev/Blog' || run.head_branch !== 'main') throw new Error('Исходный запуск не является завершившимся с ошибкой финансовым выпуском main.');
}

function commitSite(dir, message) {
  const git = args => execFileSync('git', ['-C', dir, ...args], { stdio: 'pipe', timeout: 60000 });
  git(['config', 'user.name', 'github-actions[bot]']);
  git(['config', 'user.email', 'github-actions[bot]@users.noreply.github.com']);
  git(['add', '.']);
  if (git(['diff', '--cached', '--name-only']).toString().trim()) {
    git(['commit', '-m', message]);
    git(['push']); // Never repeat an uncertain public side effect after a push failure.
  }
}

async function main() {
  const input = validateManualRequest(JSON.parse(process.env.FINANCE_MANUAL_REQUEST || '{}'));
  console.log(`::add-mask::${input.fileId}`);
  if (financeDateKey() !== input.date) throw new Error('Дата подтверждения истекла. Нажмите кнопку заново.');
  const draft = readConfirmedDraft(await downloadSavedDraft(input.fileId), input);
  await verifySourceRun(input);
  const niche = getNiche('finance'), site = resolveSite(niche), target = resolveTelegram(niche);
  const article = buildSavedFinanceArticle(draft, input, niche, target);
  if (input.testRun) {
    await writeFile('finance-manual-result.json', JSON.stringify({ text: `🧪 Тест пройден: «${article.title}». Сохранённый текст проверен и подготовлен. Канал, сайт и RSS не изменены. OpenRouter не вызывался.` }));
    console.log('Test-only validation passed: zero public writes, zero image/text model calls.');
    return;
  }
  if (!site.url || !target.botToken || !target.channelId) throw new Error('Не настроены все площадки публикации.');
  const state = await reserveManualFinance(site.dir, input, article);
  // Durable reservation goes to the content repo BEFORE paid images/public sends.
  // The workflow shares finance-post concurrency with the automatic generator.
  try { commitSite(site.dir, `finance: reserve manual ${state.draftKey}`); }
  catch { throw new Error('Не удалось надёжно сохранить резерв выпуска. Публикация не начиналась; проверьте репозиторий.'); }
  let phase = 'images';
  try {
    const { generateCoverImage } = await import('../src/cover_image.js');
    const { fetchImages } = await import('../src/unsplash.js');
    const { publishToSite } = await import('../src/site.js');
    const { postToTelegram } = await import('../src/telegram.js');
    let image = null, inlineImages;
    try { image = await generateCoverImage(article, site, niche); }
    catch { console.warn('Cover unavailable; using the ordinary Unsplash fallback.'); }
    if (image) inlineImages = await fetchImages(article.image_queries.slice(1), 2, niche.imageFallbackQueries || []);
    else { const images = await fetchImages(article.image_queries, 3, niche.imageFallbackQueries || []); image = images[0] || null; inlineImages = images.slice(1); }
    // Refuse to cross midnight under an approval for a different Moscow date.
    if (financeDateKey() !== input.date) throw new Error('Дата подтверждения истекла.');
    phase = 'site';
    const result = await publishToSite(article, image, inlineImages, site);
    if (result.skipped) throw new Error('Site skipped');
    state.siteUrl = result.url;
    phase = 'telegram';
    // Persist the uncertain-send marker too; no retry on timeout/ambiguous result.
    state.status = 'sending-telegram';
    await saveManualFinanceState(site.dir, state);
    commitSite(site.dir, `finance: saved manual article ${state.draftKey}`);
    const tg = await postToTelegram(article, image, target, { noFallback: true });
    if (tg.skipped) throw new Error('Telegram skipped');
    state.messageId = tg.messageId; state.status = 'completed'; state.completedAt = new Date().toISOString();
    phase = 'finalize';
    await saveManualFinanceState(site.dir, state);
    commitSite(site.dir, `finance: complete manual ${state.draftKey}`);
    await writeFile('finance-manual-result.json', JSON.stringify({ text: `✅ Ручной выпуск опубликован в Telegram-канале, на сайте и в RSS.\n${result.url}\nДзен заберёт статью при следующем импорте RSS. Текст не перегенерировался; замечания проверки были обойдены по вашему подтверждению.` }));
  } catch {
    state.status = 'needs-inspection'; state.failedPhase = phase;
    try { await saveManualFinanceState(site.dir, state); commitSite(site.dir, `finance: inspect manual ${state.draftKey}`); } catch { /* Existing remote reservation still blocks repeats. */ }
    throw new Error(`Ручной выпуск остановлен на этапе ${phase}. Резерв сохранён: повторная отправка заблокирована во избежание дубля. Нужна проверка канала и сайта.`);
  }
}

if (process.argv[1]?.endsWith('publish_finance_draft.js')) {
  if (process.argv.includes('--notify')) {
    (async () => {
      let text = '⚠️ Ручной выпуск не завершён. Проверьте журнал, канал и сайт перед повторной попыткой.';
      try { text = JSON.parse(await readFile('finance-manual-result.json', 'utf8')).text; } catch { /* Failure before a result was recorded. */ }
      if (!/^\d+$/.test(process.env.FINANCE_ALERT_CHAT_ID || '')) throw new Error('Только личный чат администратора.');
      await telegram('sendMessage', { chat_id: process.env.FINANCE_ALERT_CHAT_ID, text: `${text}\nhttps://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`, disable_web_page_preview: true });
    })().catch(() => { console.error('Private manual result notification failed.'); process.exitCode = 1; });
  } else main().catch(async error => {
    // Avoid printing exception stacks/URLs from Telegram, git and image providers.
    const text = String(error.message || '').includes('token') ? 'Ручной выпуск остановлен; проверьте журнал.' : error.message;
    console.error(text);
    await writeFile('finance-manual-result.json', JSON.stringify({ text: `⚠️ ${text}` }));
    process.exitCode = 1;
  });
}
