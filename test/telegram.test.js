import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { postToTelegram } from '../src/telegram.js';

const article = {
  title: 'Проверочная статья',
  html: '<p>Текст статьи.</p><h2>Подзаголовок</h2><p>Продолжение.</p>',
  tags: ['тест'],
};
const target = {
  botToken: 'test-token',
  channelId: '@test_channel',
};

test('локальная обложка загружается внутри одного sendRichMessage', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telegram-rich-'));
  const coverPath = path.join(dir, 'cover.jpg');
  await writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      json: async () => ({ ok: true, result: { message_id: 42 } }),
    };
  };

  try {
    const result = await postToTelegram(article, {
      url: 'https://example.test/cover.jpg',
      localPath: coverPath,
      filename: 'cover.jpg',
      mediaType: 'image/jpeg',
    }, target);

    assert.equal(result.messageId, 42);
    assert.equal(result.rich, true);
    assert.equal(result.localCover, true);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/sendRichMessage$/);

    const form = requests[0].options.body;
    assert.ok(form instanceof FormData);
    assert.equal(form.get('chat_id'), '@test_channel');

    const richMessage = JSON.parse(form.get('rich_message'));
    assert.match(richMessage.html, /^<img src="tg:\/\/photo\?id=cover">/);
    assert.equal(richMessage.media[0].id, 'cover');
    assert.equal(richMessage.media[0].media.type, 'photo');
    assert.equal(richMessage.media[0].media.media, 'attach://cover_file');
    assert.ok(form.get('cover_file') instanceof Blob);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('при ошибке Rich-поста с обложкой не отправляет отдельный sendPhoto', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'telegram-rich-error-'));
  const coverPath = path.join(dir, 'cover.jpg');
  await writeFile(coverPath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  const originalFetch = globalThis.fetch;
  const methods = [];
  globalThis.fetch = async (url) => {
    methods.push(new URL(url).pathname.split('/').at(-1));
    return {
      json: async () => ({ ok: false, description: 'Bad Request' }),
    };
  };

  try {
    await assert.rejects(
      () => postToTelegram(article, {
        url: 'https://example.test/cover.jpg',
        localPath: coverPath,
        filename: 'cover.jpg',
        mediaType: 'image/jpeg',
      }, target),
      /Единый Telegram Rich-пост с локальной обложкой не отправлен/,
    );
    assert.deepEqual(methods, ['sendRichMessage']);
  } finally {
    globalThis.fetch = originalFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

test('удалённая обложка остаётся одним JSON Rich-сообщением', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return {
      json: async () => ({ ok: true, result: { message_id: 73 } }),
    };
  };

  try {
    const result = await postToTelegram(article, { url: 'https://example.test/cover.jpg' }, target);
    assert.equal(result.messageId, 73);
    assert.equal(requests.length, 1);
    assert.match(requests[0].url, /\/sendRichMessage$/);

    const payload = JSON.parse(requests[0].options.body);
    assert.equal(payload.rich_message.media[0].media.media, 'https://example.test/cover.jpg');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
