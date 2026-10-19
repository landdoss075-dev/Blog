import { readFile } from 'node:fs/promises';
import { FINANCE_DRAFT_FILE, renderFinanceDraftDocument } from '../src/finance-drafts.js';

export async function sendFinanceFailure({ token, chatId, runUrl, draftBundle, testMode = false, fetchImpl = fetch }) {
  if (!token || !/^\d+$/.test(String(chatId || ''))) {
    throw new Error('Не настроены приватные FINANCE_ALERT_BOT_TOKEN / FINANCE_ALERT_CHAT_ID.');
  }
  let response;
  let method = 'sendMessage';
  const text = testMode
    ? '🧪 Проверка кнопок на техническом примере. Просмотр — только в личном чате. Тест публикации не меняет канал, сайт и RSS и не вызывает OpenRouter.'
    : `⚠️ Финансовые будни: запуск завершился с ошибкой. Проверьте журнал и фактическое наличие статьи перед повторным запуском, чтобы не создать дубль.\n${runUrl}`;
  let body;
  let headers;
  let draftHtml;
  if (draftBundle?.drafts?.length) {
    try { draftHtml = renderFinanceDraftDocument({ ...draftBundle, testOnly: testMode || draftBundle.testOnly === true }); }
    catch { console.warn('Черновик повреждён или слишком большой: отправляю обычное уведомление без кнопки.'); }
  }
  if (draftHtml) {
    method = 'sendDocument';
    body = new FormData();
    body.append('chat_id', String(chatId));
    body.append('caption', `${text}\n\n«Просмотр» — текст только вам. «Публикация» СРАЗУ выпускает сохранённую статью в канал, на сайт и в RSS, обходя замечания проверки. Возможны ошибки — сначала прочитайте текст! Обложка может расходовать кредиты. Максимум 1 статья в день.`.slice(0, 1024));
    body.append('document', new Blob([draftHtml], { type: 'text/html' }), `finance-drafts-${draftBundle.runId}.html`);
    body.append('reply_markup', JSON.stringify({ inline_keyboard: draftBundle.drafts.map((draft, i) => [{
      text: draftBundle.drafts.length === 1 ? '📄 Показать текст черновика' : `📄 Черновик ${i + 1}: ${draft.title.slice(0, 35)}`,
      callback_data: `finance_draft_view:${i}`,
    }, ...(draftBundle.publicationStarted === false ? [{ text: testMode ? '🧪 Тест публикации' : '📢 Публикация', callback_data: `finance_draft_publish:${i}` }] : [])]) }));
  } else {
    headers = { 'Content-Type': 'application/json' };
    body = JSON.stringify({ chat_id: chatId, text: `${text}\n\nГотовый черновик не сохранён — кнопка просмотра недоступна.`, disable_web_page_preview: true });
  }
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers, body,
    });
  } catch {
    // URL содержит токен: не выводим сетевую ошибку целиком.
    throw new Error('Сетевая ошибка приватного уведомления о финансовом выпуске.');
  }
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Приватное уведомление не доставлено (HTTP ${response.status}).`);
  return result.result;
}

if (process.argv[1]?.endsWith('notify_finance_failure.js')) {
  (async () => {
    let draftBundle;
    try { draftBundle = JSON.parse(await readFile(FINANCE_DRAFT_FILE, 'utf8')); }
    catch { /* Ошибка до генерации: уведомление без кнопки. */ }
    if (draftBundle && String(draftBundle.runId) !== process.env.GITHUB_RUN_ID) draftBundle = undefined;
    return sendFinanceFailure({ token: process.env.FINANCE_ALERT_BOT_TOKEN,
      chatId: process.env.FINANCE_ALERT_CHAT_ID,
      runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      draftBundle,
    });
  })().then(() => console.log('Приватное уведомление о сбое доставлено.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
