import test from 'node:test';
import assert from 'node:assert/strict';

import { pickEditorialTopic } from '../src/news.js';
import { selectDistinctTitle } from '../src/prompt.js';

test('editorial picker moves away from an overused animal group', () => {
  const niche = {
    newsQueries: [],
    editorialTopics: [
      'Кошка снова ждёт у закрытой двери',
      'Собака не хочет выходить в дождь',
      'Попугай кричит в одно и то же время',
    ],
    topicDiversityWindow: 5,
    topicDiversityGroups: [
      { key: 'cats', terms: ['кошка', 'кот '] },
      { key: 'dogs', terms: ['собака'] },
      { key: 'birds', terms: ['попугай'] },
    ],
  };
  const recentPosts = [
    { title: 'Кошка перестала спать на подоконнике' },
    { title: 'Кот будит хозяина в четыре утра' },
    { title: 'Кошка царапает диван возле когтеточки' },
  ];

  const selected = pickEditorialTopic(niche, recentPosts, new Date('2026-08-05T07:00:00Z'));
  assert.doesNotMatch(selected, /кошк|кот /i);
});

test('title selector avoids a repeated opening when another variant exists', () => {
  const article = {
    title: 'Приехала к сестре и увидела старую книгу',
    titleVariants: [
      'Приехала к сестре и увидела старую книгу',
      'Одна фраза сестры вернула нас к обиде десятилетней давности',
      'Приехала к тёте и поняла, почему мы редко созваниваемся',
    ],
  };

  selectDistinctTitle(article, [
    'Приехала к сестре на выходные и увидела книгу на столе',
    'Приехала к тёте на три дня и застряла в её строгих правилах',
  ]);

  assert.equal(
    article.title,
    'Одна фраза сестры вернула нас к обиде десятилетней давности',
  );
});
