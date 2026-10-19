import { readFile, access } from 'node:fs/promises';

export const financeDateKey = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);

export async function assertFinanceDayAvailable(dir, posts, now = new Date()) {
  if (financePublishedToday(posts, now)) throw new Error('Сегодня по Москве статья уже опубликована. Второй выпуск запрещён.');
  let reserved = false;
  try { await access(`${dir}/.finance-manual-publish/dates/${financeDateKey(now)}.json`); reserved = true; }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (reserved) throw new Error('За сегодня уже зарезервирован ручной выпуск. Проверьте его результат перед повторной публикацией.');
}

// В concurrency-группе второй запуск читает уже обновлённый контентный репозиторий.
export function financePublishedToday(posts, now = new Date()) {
  const dateKey = date => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return posts.some(post => Number.isFinite(Date.parse(post.date)) && dateKey(new Date(post.date)) === dateKey(now));
}

if (process.argv[1]?.endsWith('check_finance_daily_limit.js')) {
  if (process.env.DRY_RUN !== '1') {
    const posts = JSON.parse(await readFile('channels/finance/docs/posts.json', 'utf8'));
    await assertFinanceDayAvailable('channels/finance/docs', posts);
  }
}
