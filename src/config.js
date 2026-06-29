import 'dotenv/config';

/**
 * Централизованная конфигурация. Все переменные окружения читаются здесь,
 * чтобы остальные модули не лазили в process.env напрямую.
 */

const truthy = (v) => v !== undefined && v !== '' && v !== '0' && v.toLowerCase?.() !== 'false';

// --dry-run в аргументах или DRY_RUN=1 в окружении
const dryRunFlag = process.argv.includes('--dry-run') || truthy(process.env.DRY_RUN);

export const config = {
  dryRun: dryRunFlag,

  // Провайдер генерации текста: 'groq' (бесплатно) или 'openai' (платно).
  provider: (process.env.PROVIDER || 'groq').toLowerCase(),

  groq: {
    apiKey: process.env.GROQ_API_KEY || '',
    model: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  },

  openai: {
    apiKey: process.env.OPENAI_API_KEY || '',
    model: process.env.OPENAI_MODEL || 'gpt-4o',
  },

  openrouter: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    model: process.env.OPENROUTER_MODEL || 'openai/gpt-5-mini',
  },

  unsplash: {
    accessKey: process.env.UNSPLASH_ACCESS_KEY || '',
  },

  telegram: {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    channelId: process.env.TELEGRAM_CHANNEL_ID || '',
    // Публичная ссылка на канал — для кросс-промо в статьях на сайте/Дзене.
    // При смене @username канала достаточно поменять эту переменную.
    channelUrl: process.env.TELEGRAM_CHANNEL_URL || 'https://t.me/ai_news_blog',
  },

  // Публикация на сайт atmoapp.ru (через ingest-эндпоинт его бэкенда).
  atmoapp: {
    apiUrl: process.env.ATMO_API_URL || '', // напр. https://atmoapp.ru/api
    secret: process.env.ATMO_INGEST_SECRET || '',
  },

  // Сайт на GitHub Pages — источник RSS-ленты для импорта в Яндекс Дзен.
  site: {
    // Базовый URL сайта, напр. https://USERNAME.github.io/REPO (без слэша в конце).
    url: (process.env.SITE_URL || '').replace(/\/+$/, ''),
    title: process.env.SITE_TITLE || 'ИИ-инструменты: блог',
    description: process.env.SITE_DESCRIPTION || 'Практические статьи про ИИ-инструменты и нейросети.',
    author: process.env.SITE_AUTHOR || 'Редакция',
    // Каталог-источник GitHub Pages (раздаётся как сайт).
    dir: process.env.SITE_DIR || 'docs',
    // Сколько последних статей держать в ленте/на сайте.
    maxPosts: Number(process.env.SITE_MAX_POSTS || 50),
  },

  // Запросы для парсинга Google News RSS. Несколько разнотематических запросов дают
  // более разнообразный пул тем — легче подобрать 3 РАЗНЫЕ статьи в день.
  newsQueries: [
    'искусственный интеллект новости',
    'нейросети инструменты 2026',
    'ChatGPT Midjourney обновление',
    'новые ИИ сервисы и приложения',
    'нейросети для творчества и работы',
    'ИИ для бизнеса и продуктивности',
  ],
};

/** Проверка обязательных ключей. Бросает, если их нет. */
export function assertRequired() {
  if (config.provider === 'groq' && !config.groq.apiKey) {
    throw new Error('PROVIDER=groq, но не задан GROQ_API_KEY.');
  }
  if (config.provider === 'openai' && !config.openai.apiKey) {
    throw new Error('PROVIDER=openai, но не задан OPENAI_API_KEY.');
  }
  if (config.provider === 'openrouter' && !config.openrouter.apiKey) {
    throw new Error('PROVIDER=openrouter, но не задан OPENROUTER_API_KEY.');
  }
}
