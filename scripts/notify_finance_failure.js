export async function sendFinanceFailure({ token, chatId, runUrl, fetchImpl = fetch }) {
  if (!token || !/^\d+$/.test(String(chatId || ''))) {
    throw new Error('Не настроены приватные FINANCE_ALERT_BOT_TOKEN / FINANCE_ALERT_CHAT_ID.');
  }
  let response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId,
        text: `⚠️ Финансовые будни: запуск завершился с ошибкой. Проверьте журнал и фактическое наличие статьи перед повторным запуском, чтобы не создать дубль.\n${runUrl}`,
        disable_web_page_preview: true,
      }),
    });
  } catch {
    // URL содержит токен: не выводим сетевую ошибку целиком.
    throw new Error('Сетевая ошибка приватного уведомления о финансовом выпуске.');
  }
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Приватное уведомление не доставлено (HTTP ${response.status}).`);
}

if (process.argv[1]?.endsWith('notify_finance_failure.js')) {
  sendFinanceFailure({ token: process.env.FINANCE_ALERT_BOT_TOKEN,
    chatId: process.env.FINANCE_ALERT_CHAT_ID,
    runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
  }).then(() => console.log('Приватное уведомление о сбое доставлено.'))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
