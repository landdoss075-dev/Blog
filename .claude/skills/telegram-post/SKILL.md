---
name: telegram-post
description: >-
  Опубликовать статью в Telegram-канал «Нейробудни» (@ai_news_blog) одним
  оформленным постом «как на Дзене» — обложка + заголовок + тело со списками и
  ссылками. Использовать, когда просят вручную/разово запостить статью в Telegram,
  переслать конкретную статью в канал, или разобраться, как работает публикация в
  Telegram. Автопостинг (cron) делает src/telegram.js сам — этот скилл для ручных
  публикаций и как справочник по механике Rich Messages.
---

# Публикация статьи в Telegram-канал

Проект автопостит в Telegram-канал **«Нейробудни» @ai_news_blog** (бот
**@botpostaiblog_bot**) оформленными постами через **Rich Messages (Bot API 10.1)**.
Один пост = обложка сверху + заголовок + тело статьи с подзаголовками, списками,
жирным и кликабельными ссылками.

## Быстрый способ — CLI-скрипт

`scripts/post_to_telegram.js` переиспользует боевую `src/telegram.js`.
Запускать из `d:\Blog` (нужен `.env` с `TELEGRAM_BOT_TOKEN` и `TELEGRAM_CHANNEL_ID`).

```bash
# Последняя статья из RSS-ленты atmoapp.ru → в канал
node scripts/post_to_telegram.js --rss-latest

# Конкретная статья по части заголовка
node scripts/post_to_telegram.js --rss-match "тамбовского промышленника"

# Из своего JSON-файла { "title","html","imageUrl" }
node scripts/post_to_telegram.js --file out/article-XXXX.json

# Проверить, что уйдёт, НЕ отправляя:
node scripts/post_to_telegram.js --rss-latest --dry

# В другой чат/канал (напр. в личку на тест — узнать chat_id см. ниже):
node scripts/post_to_telegram.js --rss-latest --chat 630393753
```

**Всегда сперва прогони с `--dry`** — покажет заголовок/объём/обложку без отправки.
Источник статей по умолчанию — RSS `https://atmoapp.ru/blog/rss.xml` (там свежие статьи
с полным HTML). Скрипт сам убирает инлайн-`<img>` из тела (в Rich по URL они не
рендерятся) — обложка идёт из `enclosure`/`imageUrl`.

## ⚠️ Тестировать — в личку, не в канал

Прод-канал виден подписчикам. Для проверки рендера шли в личный чат:
- chat_id тестового пользователя (@hackyoou): **630393753**
- Чтобы бот мог писать в личку, пользователь должен сперва написать боту `/start`.
- Узнать chat_id: `getUpdates` у бота → `message.chat.id` приватных чатов.

## Как это устроено (механика Rich Messages, Bot API 10.1)

Ключевое — я долго искал правильную схему, вот она:

- **Метод:** `sendRichMessage` с параметрами `chat_id`, `rich_message` (InputRichMessage).
- **`InputRichMessage`** принимает ГОТОВУЮ HTML-строку в поле `html` (либо `markdown`),
  а НЕ дерево блоков. `{blocks:[...]}` → ошибка `rich message must be non-empty`.
  Классы RichBlock*/RichText* — для ПОЛУЧАЕМЫХ сообщений, при отправке не нужны.
- **Картинка в тот же пост** (иначе выходит 2 сообщения): у `InputRichMessage` есть поле
  `media` (Array of `InputRichMessageMedia`). В html ставим `<img src="tg://photo?id=cover">`,
  в media — `[{ id:'cover', media:{ type:'photo', media:'<URL>' } }]`.
  `InputMediaPhoto.media` принимает **HTTP-URL напрямую** — Telegram сам скачивает картинку,
  **file_id НЕ нужен** (это снимало блокер «RichBlockPhoto требует file_id»).
- **Принятые теги в html:** h1/h2/h3/p/ul/ol/li/b/strong/i/em/br/a (проверено). Лимит 32768 симв.
- **Фолбэк** в `src/telegram.js`: если `sendRichMessage` упадёт (клиент не поддерживает) —
  обычный пост (sendPhoto + текст, h2→<b>, li→«•», разбивка по 4096). Прод не сломается.

Минимальный сырой вызов (для отладки):
```js
await fetch(`https://api.telegram.org/bot${TOKEN}/sendRichMessage`, {
  method:'POST', headers:{'Content-Type':'application/json'},
  body: JSON.stringify({
    chat_id: '@ai_news_blog',
    rich_message: {
      html: '<img src="tg://photo?id=cover"><h1>Заголовок</h1><p>Текст…</p>',
      media: [{ id:'cover', media:{ type:'photo', media:'https://…/photo.jpg' } }],
    },
  }),
});
```

## Где что в коде
- `src/telegram.js` — боевая `postToTelegram(article, image)`: собирает Rich-html
  (`buildRichHtml`) + media[], один `sendRichMessage`, фолбэк `postFallback`.
- `scripts/post_to_telegram.js` — CLI-обёртка для ручных публикаций (этот скилл).
- Ссылка на канал в статьях («Нейробудни», `<a href>`) добавляется в `src/prompt.js`
  (CTA после санитайзера); в TG-пост поле `article.telegram` НЕ несёт ссылку на свой канал.
