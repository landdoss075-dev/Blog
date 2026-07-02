import { config } from './config.js';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Вызов OpenRouter (OpenAI-совместимый API, один ключ на все модели).
 * Имя модели — с префиксом провайдера, напр. "openai/gpt-5-mini",
 * "anthropic/claude-...", "meta-llama/llama-3.3-70b-instruct".
 */
export async function callOpenRouter(messages) {
  const model = config.openrouter.model;
  // Reasoning-модели (gpt-5, o-серия) тратят часть лимита на «размышления».
  const isReasoning = /gpt-5|\/o\d/i.test(model);

  const body = {
    model,
    response_format: { type: 'json_object' },
    messages,
    // 4000 для обычных моделей: статья 700-1100 слов + версия для Telegram + JSON-обёртка
    // не влезают в 2048 (Sonnet/gpt-5-mini обрезали бы ответ → битый JSON).
    max_tokens: isReasoning ? 8000 : 4000,
  };
  if (isReasoning) {
    body.reasoning = { effort: 'low' }; // унифицированный параметр OpenRouter
  } else {
    body.temperature = 0.8;
  }

  const res = await fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openrouter.apiKey}`,
      'Content-Type': 'application/json',
      // Необязательные заголовки для рейтинга на openrouter.ai:
      'HTTP-Referer': 'https://github.com/ai-blog-autoposter',
      'X-Title': 'AI Blog Autoposter',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenRouter API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  if (data.error) {
    throw new Error(`OpenRouter: ${data.error.message || JSON.stringify(data.error)}`);
  }
  return data.choices?.[0]?.message?.content;
}
