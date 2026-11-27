import { Language } from '@prisma/client';
import type { WorldRunObjectType } from './world-write.data';
import { objectWriteRequest, selectWriteRequest, worldReviewRequest } from './world-write.prompts';

/**
 * Проза правил страницы предмета, понятия и события (`F08-13b-1`, `F08-13b-2`): текст, который видит
 * модель на шаге страницы и проверяющая на `world_review`. Посадка на круг 2 `/qa` 13b-2: замена
 * имени переменной `what` прошла по самим строкам («type the thing is») - ни один тест текст не держал.
 */
const PHRASES: Record<WorldRunObjectType, string[]> = {
  object: [
    'what the thing is, whose it is, where it appears',
    'and what it means for the book',
    'what this thing is and who has it',
    'thing - what it is, whose it is, where it appears and why the book needs it',
  ],
  term: ['what it means in this book', 'what the word means, then whom or what'],
  event: [
    'who takes part, what happens in it',
    'what the episode is and who takes part',
    'episode - what happens in it, who takes part and why the book needs it',
  ],
};

const text = (value: unknown): string => JSON.stringify(value);

const pageInput = (type: WorldRunObjectType) => ({
  language: Language.en,
  type,
  bookTitle: 'Book',
  author: 'Author',
  key: 'k',
  name: 'Name',
  aliases: '',
  chapterList: '1 - One',
  mentionChapters: '1 - 2',
  keys: '',
  worldCharacters: '',
  themes: '',
  analysis: '',
  glossary: '',
  example: '{}',
  book: 'text',
  bookIsPartial: false,
  regen: null,
  redo: null,
});

const page = (type: WorldRunObjectType) => text(objectWriteRequest(pageInput(type)));

const review = (kind: WorldRunObjectType) =>
  text(
    worldReviewRequest({
      kind,
      language: Language.en,
      book: 'text',
      analysis: '',
      answer: {},
      regenBlock: null,
    }),
  );

describe('правила страницы предмета, понятия и события (F08-13b)', () => {
  it.each(['object', 'term', 'event'] as const)('%s: шаг страницы несёт свои фразы', (type) => {
    const request = page(type);
    for (const phrase of PHRASES[type]) expect(request).toContain(phrase);
    expect(request).not.toMatch(/[:,] type (the|it|this|happens)\b/);
  });

  it.each(['object', 'term', 'event'] as const)(
    '%s: проверяющая читает те же правила, что и шаг',
    (type) => {
      const request = review(type);
      // Вступление страницы проверяющей не уходит - только правила и поля типа.
      for (const phrase of PHRASES[type].filter((p) => !p.includes('why the book needs it'))) {
        expect(request).toContain(phrase);
      }
      expect(request).not.toMatch(/[:,] type (the|it|this|happens)\b/);
    },
  );
});

// /qa круг 3 13b-2 (решение `F08 | F08-13b-2` «круг 3»): правила событий в выборе и на странице.
describe('правила событий: выбор и страница (F08-13b-2)', () => {
  const select = text(
    selectWriteRequest({
      language: Language.es,
      bookTitle: 'Book',
      author: 'Author',
      candidates: '',
      places: '',
      objects: '',
      terms: '',
      eventsOn: 'yes',
      knownEvents: '',
      originalLanguage: 'Russian',
      dossierNames: '',
      glossary: '',
      chapterList: '1 — One',
      book: 'text',
      redo: null,
    }),
  );

  it('выбор: originalName - перевод названия на язык оригинала, name - заголовок эпизода', () => {
    expect(select).toContain(
      'originalName - the title of this episode in ORIGINAL_LANGUAGE, the original language of the book (translate the title when you do not know the original one)',
    );
    expect(select).toContain('name - a short title of the episode in the language of this version');
    expect(select).not.toContain('as the original text calls it');
  });

  it('страница события: главы выбора первыми при неполном тексте; связи - из блоков типа', () => {
    const partial = text(objectWriteRequest({ ...pageInput('event'), bookIsPartial: true }));
    expect(partial).toContain('you get the chapters the choice step named for the episode');
    const links = (type: WorldRunObjectType) => text(objectWriteRequest(pageInput(type)));
    // У предмета - герои и темы, у события - только герои, у понятия связей нет (`worldTypeHasBlock`).
    expect(links('object')).toContain('THEMES');
    expect(links('object')).toContain('WORLD_CHARACTERS');
    expect(links('event')).toContain('WORLD_CHARACTERS');
    expect(links('event')).not.toContain('THEMES');
    expect(links('term')).not.toContain('WORLD_CHARACTERS');
  });
});
