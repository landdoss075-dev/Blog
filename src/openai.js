import { config } from './config.js';

const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

/**
 * Вызов OpenAI chat-completions. Возвращает сырой текст ответа модели.
 *
 * Учитывает особенности новых моделей (gpt-5, o-серия):
 *  - они используют max_completion_tokens вместо max_tokens;
 *  - не принимают кастомную temperature (только дефолтную).
 */
export async function callOpenAI(messages) {
  const model = config.openai.model;
  const isReasoning = /^(o\d|gpt-5)/i.test(model);

  const body = {
    model,
    response_format: { type: 'json_object' },
    messages,
    // У reasoning-моделей часть лимита съедают внутренние «думающие» токены,
    // поэтому даём запас, чтобы на сам текст статьи точно хватило.
    max_completion_tokens: isReasoning ? 8000 : 2048,
  };
  if (isReasoning) {
    // Для написания статьи глубокое рассуждение не нужно — экономим токены и время.
    body.reasoning_effort = 'low';
  } else {
    body.temperature = 0.8;
  }

  const res = await fetch(OPENAI_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.openai.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OpenAI API ${res.status}: ${text.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}
