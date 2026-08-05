import test from 'node:test';
import assert from 'node:assert/strict';

import { fetchTopic, pickEditorialTopic } from '../src/news.js';
import { buildMessages, buildUserPrompt, selectDistinctTitle } from '../src/prompt.js';
import { niches } from '../src/niches.js';

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

test('Neurobudni follows the 3 practical, 2 search, 1 lab, 1 safety weekly schedule', () => {
  const expectedGroups = [
    'practical',
    'search',
    'practical',
    'lab',
    'search',
    'practical',
    'safety',
  ];

  expectedGroups.forEach((expectedGroup, offset) => {
    const date = new Date(Date.UTC(2026, 7, 3 + offset, 7));
    const selected = pickEditorialTopic(niches.ai, [], date);
    assert.equal(selected.group, expectedGroup);
    assert.ok(selected.theme);
    assert.ok(selected.format);
  });
});

test('Neurobudni does not repeat the same main object on consecutive days', () => {
  const selected = pickEditorialTopic(
    niches.ai,
    [{ title: 'Резюме с номером телефона в нейросети: что с ним происходит дальше' }],
    new Date('2026-08-05T07:00:00Z'),
  );

  assert.doesNotMatch(selected.theme, /резюме/i);
  assert.equal(selected.group, 'practical');
});

test('Neurobudni produces a non-repeating 14-day editorial run', () => {
  const recentPosts = [];
  const selectedThemes = new Set();
  const expectedSchedule = niches.ai.editorialSchedule;

  for (let offset = 0; offset < 14; offset++) {
    const date = new Date(Date.UTC(2026, 7, 3 + offset, 7));
    const selected = pickEditorialTopic(niches.ai, recentPosts, date);
    const expectedGroup = expectedSchedule[offset % expectedSchedule.length];
    assert.equal(selected.group, expectedGroup);
    assert.equal(selectedThemes.has(selected.theme), false, `Повтор темы: ${selected.theme}`);
    selectedThemes.add(selected.theme);
    recentPosts.unshift({
      title: selected.theme,
      source: {
        headline: selected.theme,
        topicGroup: selected.group,
      },
    });
  }

  assert.equal(selectedThemes.size, 14);
});

test('Neurobudni prompt uses the selected intent and the shorter restart length', () => {
  const selected = pickEditorialTopic(
    niches.ai,
    [],
    new Date('2026-08-03T07:00:00Z'),
  );
  const topic = {
    ...selected,
    theme: selected.theme,
    headline: selected.theme,
    headlines: [selected.theme],
    topicGroup: selected.group,
    topicIntent: selected.intent,
    editorialFormat: selected.format,
    editorialTitleStyle: selected.titleStyle,
    topicOrigin: 'editorial',
    currentDate: '2026-08-03',
    persona: niches.ai.persona,
    editorialVoice: true,
    promptGuidance: niches.ai.promptGuidance,
    topicLabel: niches.ai.topicLabel,
    promptMinWords: niches.ai.promptMinWords,
    maxWords: niches.ai.maxWords,
  };

  const userPrompt = buildUserPrompt(topic);
  const messages = buildMessages(topic);
  assert.match(userPrompt, /Тип материала: practical/);
  assert.match(userPrompt, new RegExp(selected.intent.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(userPrompt, new RegExp(selected.format.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(messages[0].content, /Объём основного текста: 500-750 слов/);
});

test('Neurobudni topic pipeline stays editorial and never fetches a random news hook', async () => {
  const niche = { ...niches.ai, dir: 'test/fixtures/no-posts' };
  const topic = await fetchTopic(niche);
  Object.assign(topic, {
    persona: niche.persona,
    editorialVoice: niche.editorialVoice,
    promptGuidance: niche.promptGuidance,
    promptFormats: niche.promptFormats,
    titleStyles: niche.titleStyles,
    topicLabel: niche.topicLabel,
    promptMinWords: niche.promptMinWords,
    maxWords: niche.maxWords,
  });

  const messages = buildMessages(topic);
  assert.equal(topic.topicOrigin, 'editorial');
  assert.ok(topic.topicGroup);
  assert.ok(topic.topicIntent);
  assert.doesNotMatch(messages[1].content, /Горячая тема дня|Самый популярный новостной/i);
  assert.match(messages[1].content, /Редакционная тема дня/);
});
