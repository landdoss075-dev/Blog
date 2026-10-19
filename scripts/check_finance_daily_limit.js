import { readFile } from 'node:fs/promises';

// В concurrency-группе второй запуск читает уже обновлённый контентный репозиторий.
export function financePublishedToday(posts, now = new Date()) {
  const dateKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return posts.some(post => Number.isFinite(Date.parse(post.date)) && dateKey(new Date(post.date)) === dateKey(now));
}

if (process.argv[1]?.endsWith('check_finance_daily_limit.js')) {
  if (process.env.DRY_RUN !== '1') {
    const posts = JSON.parse(await readFile('channels/finance/docs/posts.json', 'utf8'));
    if (financePublishedToday(posts)) throw new Error('Сегодня по Москве статья уже опубликована. Второй автоматический выпуск запрещён.');
  }
}
