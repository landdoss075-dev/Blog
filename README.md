# AI Tools Blog — Autoposter

Автопостер статей для русскоязычных контентных каналов.
Текущий боевой фокус — **«Финансовые будни»**: бытовые финансы 45+, льготы, ЖКХ,
капремонт, пенсии, наследство, выплаты и документы.
Пайплайн: тема → статья через OpenRouter → обложка → **Telegram-канал** и **сайт GitHub Pages**,
RSS которого импортирует **Яндекс Дзен**.
Без сервера — всё на GitHub Actions (cron).

План проекта — в [projectblog.md](projectblog.md), история — в [changelogblog.md](changelogblog.md).

## Как публикуется в Дзен

⚠️ У Яндекс Дзена **нет API автопубликации**. Поэтому скрипт генерирует статьи как страницы
статического сайта на GitHub Pages и обновляет `docs/rss.xml`. Дзен подключается к этой RSS-ленте
и импортирует статьи сам. Бонус — собственный сайт как третья площадка.

## Структура

```
src/
  config.js     — переменные окружения и настройки
  log.js        — логгер
  news.js       — горячая тема дня (Google News RSS + трендоскоп)
  prompt.js     — общий промпт, парсинг и нормализация ответа
  sanitize.js   — чистка HTML от модели (защита автопостинга)
  groq.js / openai.js / openrouter.js — клиенты провайдеров
  llm.js        — роутер по PROVIDER
  unsplash.js   — картинка
  telegram.js   — публикация в Telegram
  site.js       — генерация сайта + RSS (для Дзена)
scripts/
  generate_and_post.js   — оркестратор пайплайна
  compare_providers.js   — сравнение моделей на одной теме (npm run compare)
.github/workflows/
  daily_post.yml         — cron 10:00 МСК + коммит сайта
docs/                    — генерируется: сайт GitHub Pages + rss.xml
```

## Текущая контентная стратегия

С сентября 2026 основной KPI — не просто показы, а рост подписчиков Дзена и дочитывания
от подписчиков для выхода на монетизацию.

Для «Финансовых будней» включён отдельный режим:

- внешний Telegram-CTA в конце финансовых статей отключён;
- финальный блок зовёт подписаться на сам канал;
- темы строятся как мини-серии без повторов: один общий пласт, но разные углы — квитанция,
  возраст, собственность, отказ, наследство, личный кабинет, региональное условие;
- генератор не должен выпускать больше двух материалов подряд с одним центральным словом
  вроде `капремонт`, `наследство` или `пособие`.

## Провайдеры генерации

Переключаются одной переменной `PROVIDER` (+ имя модели):

| PROVIDER | Ключ | Модель (пример) | Цена |
|---|---|---|---|
| `openrouter` | `OPENROUTER_API_KEY` | `anthropic/claude-sonnet-5` / `anthropic/claude-opus-5` | зависит от модели |
| `openai` | `OPENAI_API_KEY` | `gpt-4o` / `gpt-5` | ~2¢/статья |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | бесплатно |

Текущий выбор — **OpenRouter + Claude Sonnet 5** как базовая модель; Opus 5 используется
для A/B-сравнения в финансовом workflow.

## Локальный запуск

```bash
npm install
cp .env.example .env        # заполнить ключи (Windows: copy .env.example .env)

npm run dry        # сгенерировать статью в out/, ничего не публикуя
npm start          # полный прогон с публикацией
npm run compare    # сравнить две модели на одной теме (нужны оба ключа)
```

Площадки без ключа мягко пропускаются — можно тестировать постепенно.

## Деплой на GitHub Actions

1. Запушить репозиторий на GitHub.
2. **Settings → Pages**: source = ветка `main`, папка `/docs`. Запомнить URL сайта.
3. **Settings → Secrets and variables → Actions**:
   - *Secrets*: `OPENROUTER_API_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHANNEL_ID`, `UNSPLASH_ACCESS_KEY` (опц.)
   - *Variables*: `PROVIDER=openrouter`, `OPENROUTER_MODEL=anthropic/claude-sonnet-5`, `SITE_URL=https://USERNAME.github.io/REPO`, `SITE_TITLE`, `SITE_DESCRIPTION`
4. **Actions → Daily AI Post → Run workflow** для теста (есть галка *Dry run*).
5. Дальше cron постит ежедневно в 10:00 МСК и коммитит обновлённый сайт.
6. Когда в ленте накопится ≥10 статей — подключить `…/rss.xml` в кабинете Дзена.
