import assert from 'node:assert/strict';
import test from 'node:test';
import { renderRss } from '../src/site.js';

const site = {
  title: 'Тестовый канал',
  description: 'Описание тестового канала',
  url: 'https://example.test',
  author: 'Редакция',
};

function makePost(index) {
  const day = String(20 - index).padStart(2, '0');
  const url = `${site.url}/posts/post-${index}.html`;
  return {
    title: `Материал ${index}`,
    url,
    date: `2026-08-${day}T07:00:00.000Z`,
    excerpt: `Краткое описание ${index}`,
    tags: ['произвольная тема'],
    image: {
      url: `${site.url}/assets/cover-${index}.jpg`,
      type: 'image/jpeg',
    },
    html:
      `<p>Первый абзац материала ${index}.</p>` +
      `<p><img src="${site.url}/assets/inline-${index}.jpg" alt=""></p>` +
      '<h2>Подзаголовок</h2><p><strong>Полный текст</strong> статьи.</p>' +
      '<p><b>Понравился разбор?</b> Подпишитесь на канал. ' +
      'А ещё больше — в нашем Telegram-канале <a href="https://t.me/example">«Канал»</a>.</p>',
  };
}

test('RSS соответствует обязательной разметке Дзена', () => {
  const rss = renderRss(Array.from({ length: 12 }, (_, index) => makePost(index)), site);

  assert.equal((rss.match(/<item>/g) || []).length, 10);
  assert.match(rss, /xmlns:content="http:\/\/purl\.org\/rss\/1\.0\/modules\/content\/"/);
  assert.equal((rss.match(/<content:encoded>/g) || []).length, 10);
  assert.equal((rss.match(/<category>format-article<\/category>/g) || []).length, 10);
  assert.equal((rss.match(/<category>index<\/category>/g) || []).length, 10);
  assert.equal((rss.match(/<category>comment-all<\/category>/g) || []).length, 10);
  assert.equal((rss.match(/<enclosure\b/g) || []).length, 10);
  assert.match(rss, /<figure><img src="https:\/\/example\.test\/assets\/inline-0\.jpg" alt=""><\/figure>/);
  assert.match(rss, /<b>Полный текст<\/b>/);
  assert.doesNotMatch(rss, /Понравился разбор/);
  assert.match(rss, /<b>Понравился материал\?<\/b> Подпишитесь на канал/);
  assert.doesNotMatch(rss, /t\.me\/example|Telegram-канале/);
  assert.doesNotMatch(rss, /yandex:full-text|media:content|<author>/);
  assert.doesNotMatch(rss, /произвольная тема/);
});
