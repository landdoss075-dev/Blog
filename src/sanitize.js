/**
 * Санитизация HTML от модели перед публикацией.
 * Зачем: автопостинг идёт без присмотра, а модель иногда выдаёт битый HTML
 * (наблюдали «<pМногие…» — потерянный «>») или лишние теги. Кривой HTML
 * может сломать импорт в Дзен или отображение в Telegram.
 */

const DEFAULT_ALLOWED = ['p', 'h2', 'h3', 'ul', 'ol', 'li', 'b', 'strong', 'i', 'em', 'br'];

/** Экранирует «голые» <, >, & в тексте между тегами. */
function escapeStray(text) {
  return text
    .replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Чистит HTML: чинит распространённые битые открывающие теги, оставляет только
 * разрешённые теги (без атрибутов), экранирует посторонние символы.
 */
export function sanitizeHtml(input, allowed = DEFAULT_ALLOWED) {
  let html = String(input || '');
  const allow = new Set(allowed.map((t) => t.toLowerCase()));

  // 1. Чиним битые открывающие теги без «>» (наблюдали «<pМногие»).
  const fixable = allowed.filter((t) => t !== 'br').join('|');
  html = html.replace(new RegExp(`<(${fixable})([A-Za-zА-Яа-яЁё])`, 'g'), '<$1>$2');

  // 2. Токенизация: оставляем только корректные разрешённые теги, остальное чистим.
  const tagRe = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?>/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = tagRe.exec(html)) !== null) {
    out += escapeStray(html.slice(last, m.index));
    const tag = m[1].toLowerCase();
    if (allow.has(tag)) {
      const closing = m[0].startsWith('</');
      // Сбрасываем все атрибуты — для статьи они не нужны и небезопасны.
      out += closing ? `</${tag}>` : tag === 'br' ? '<br>' : `<${tag}>`;
    }
    last = tagRe.lastIndex;
  }
  out += escapeStray(html.slice(last));

  return out.replace(/\s+\n/g, '\n').trim();
}

/** Чистый текст без тегов (для подсчёта слов, plain-версий). */
export function toPlainText(html) {
  return String(html || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
