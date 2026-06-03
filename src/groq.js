import { config } from './config.js';

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

/** Вызов Groq chat-completions. Возвращает сырой текст ответа модели. */
export async function callGroq(messages) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.groq.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.groq.model,
      temperature: 0.8,
      max_tokens: 2048,
      response_format: { type: 'json_object' },
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Groq API ${res.status}: ${body.slice(0, 300)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content;
}
