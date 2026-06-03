/** Минималистичный логгер с таймстампами и иконками статуса. */

const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const log = {
  info: (msg) => console.log(`[${stamp()}] ℹ️  ${msg}`),
  ok: (msg) => console.log(`[${stamp()}] ✅ ${msg}`),
  warn: (msg) => console.warn(`[${stamp()}] ⚠️  ${msg}`),
  error: (msg) => console.error(`[${stamp()}] ❌ ${msg}`),
  step: (msg) => console.log(`\n[${stamp()}] ▶️  ${msg}`),
};
