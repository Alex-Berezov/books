import { indexChapters } from '../draft-quality/quote-check';
import { WORLD_REMARK_CODES } from '../draft-quality/text-checks';
import {
  dossierForms,
  externalChecks,
  foldedVersion,
  importRemarks,
  pageRemarks,
  invalidBlocks,
  mentionRemarks,
  pairCoreRemarks,
  pairRemarks,
  readExternalAnswer,
  readPageAnswer,
  readPairAnswer,
  readSelectAnswer,
  verifyWorldExternal,
  WorldPageCheck,
  WorldPairCheck,
} from './world-write.checks';
import { WORLD_REVIEW_CODES } from './world-write.prompts';

/**
 * Код-проверки хода мира (`F08-4a`, карточка: «каждая код-проверка краснеет на своём входе»):
 * каждый тест - вход, на котором проверка срабатывает, и рядом чистый вход, на котором - нет.
 */

const RIVER = 'Anna walked along the cold river at dawn.';
const BELL = 'Boris rang the old bell three times over the square.';
const chapters = indexChapters(
  new Map([
    [1, RIVER],
    [2, BELL],
  ]),
);
const check: WorldPageCheck = {
  key: 'anna',
  language: 'en',
  chapters,
  mentionChapters: new Set([1]),
  refKeys: new Set(['anna', 'boris']),
  glossary: [],
  storedAppearance: null,
  briefRegen: false,
  role: 'main',
};
const quote = (text: string, chapter: number, speakerKey = '') => ({
  text,
  chapter,
  speakerKey,
  interpretation: 'What the line shows.',
});

describe('readSelectAnswer: name forms', () => {
  const folded = foldedVersion(chapters);
  const candidates = [{ key: 'anna', name: 'Anna' }];

  it('a form that is not in the text as a whole word is dropped with ALIAS_NOT_IN_TEXT; a form in the text stays', () => {
    const out = readSelectAnswer(
      { characters: [{ key: 'anna', name: 'Anna', aliases: ['Anna', 'Annushka', 'Ann'] }] },
      candidates,
      folded,
    );
    // «Ann» - часть слова «Anna», а не слово: не форма текста.
    expect(out.characters).toEqual([{ key: 'anna', name: 'Anna', aliases: ['Anna'] }]);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([
      ['ALIAS_NOT_IN_TEXT', 'characters.0.aliases.1'],
      ['ALIAS_NOT_IN_TEXT', 'characters.0.aliases.2'],
    ]);
  });

  it('a key that is not a candidate is dropped with KEY_UNKNOWN', () => {
    const out = readSelectAnswer(
      { characters: [{ key: 'boris', name: 'Boris', aliases: ['Boris'] }] },
      candidates,
      folded,
    );
    expect(out.characters).toEqual([]);
    expect(out.fixes.map((f) => f.code)).toEqual(['KEY_UNKNOWN']);
  });
});

describe('readPageAnswer: quotations, chapters, keys and limits', () => {
  it('a quotation that is not word for word is dropped with its reason; a verbatim one stays', () => {
    const out = readPageAnswer(
      { quotes: [quote(RIVER, 1), quote('Anna sang a song nobody heard.', 1)] },
      check,
    );
    expect(out.blocks.quotes?.map((q) => q.text)).toEqual([RIVER]);
    expect(out.droppedQuotes).toEqual([
      {
        key: 'anna',
        chapter: 1,
        text: 'Anna sang a song nobody heard.',
        reason: 'QUOTE_NOT_VERBATIM',
      },
    ]);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([['QUOTE_NOT_VERBATIM', 'quotes.1']]);
  });

  it('a quotation in the wrong chapter of the version is not word for word there', () => {
    const out = readPageAnswer({ quotes: [quote(RIVER, 2)] }, check);
    expect(out.blocks.quotes).toBeUndefined();
    expect(out.droppedQuotes.map((d) => d.reason)).toEqual(['QUOTE_NOT_VERBATIM']);
  });

  it('a chapter that is not in the version drops the quotation, the scene and the stage with CHAPTER_UNKNOWN', () => {
    const out = readPageAnswer(
      {
        quotes: [quote(RIVER, 9)],
        scenes: [
          { chapter: 9, title: 'x', text: 'y' },
          { chapter: 1, title: 'River', text: 'At the river.' },
        ],
        arc: { from: 'a', to: 'b', stages: [{ title: 't', text: 'x', chapter: 0 }] },
      },
      check,
    );
    expect(out.blocks.quotes).toBeUndefined();
    expect(out.blocks.scenes).toEqual([{ chapter: 1, title: 'River', text: 'At the river.' }]);
    expect(out.blocks.arc).toEqual({ from: 'a', to: 'b' });
    expect(out.droppedQuotes.map((d) => d.reason)).toEqual(['CHAPTER_UNKNOWN']);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([
      ['CHAPTER_UNKNOWN', 'arc.stages.0'],
      ['CHAPTER_UNKNOWN', 'scenes.0'],
      ['CHAPTER_UNKNOWN', 'quotes.0'],
    ]);
  });

  it('more than 12 quotations after the invented ones are dropped - the tail is cut with LIMIT_OUT (decision Q7)', () => {
    const many = [
      quote('An invented line.', 1),
      ...Array.from({ length: 13 }, () => quote(RIVER, 1)),
    ];
    const out = readPageAnswer({ quotes: many }, check);
    expect(out.blocks.quotes).toHaveLength(12);
    expect(out.fixes.map((f) => f.code)).toEqual(['QUOTE_NOT_VERBATIM', 'LIMIT_OUT']);
    const twelve = readPageAnswer(
      { quotes: Array.from({ length: 12 }, () => quote(RIVER, 1)) },
      check,
    );
    expect(twelve.fixes).toEqual([]);
  });

  it('a relation to an unknown key or to the character itself is dropped; an unknown speaker is left out', () => {
    const out = readPageAnswer(
      {
        relations: [
          { to: 'boris', label: 'brother' },
          { to: 'anna', label: 'self' },
          { to: 'ghost', label: 'nobody' },
        ],
        quotes: [quote(RIVER, 1, 'ghost'), quote(RIVER, 1, 'boris')],
      },
      check,
    );
    expect(out.blocks.relations).toEqual([{ to: 'boris', label: 'brother' }]);
    expect(out.blocks.quotes?.map((q) => q.speakerKey)).toEqual([undefined, 'boris']);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([
      ['KEY_UNKNOWN', 'relations.1'],
      ['KEY_UNKNOWN', 'relations.2'],
      ['KEY_UNKNOWN', 'quotes.0.speakerKey'],
    ]);
  });

  it('empty strings of the strict form are «no value»: no block', () => {
    const out = readPageAnswer(
      {
        short: '  ',
        appearance: '',
        profile: { position: '', relationToMain: '' },
        arc: { from: '', to: '', stages: [] },
      },
      check,
    );
    expect(out.blocks).toEqual({});
  });
});

describe('mentionRemarks: scenes only where the character is', () => {
  it('a scene or a stage in a chapter without the character - SCENE_OUTSIDE_MENTIONS; in its chapter - none', () => {
    expect(
      mentionRemarks(
        {
          scenes: [
            { chapter: 1, title: 'a', text: 'b' },
            { chapter: 2, title: 'c', text: 'd' },
          ],
          arc: { from: 'a', to: 'b', stages: [{ title: 't', text: 'x', chapter: 2 }] },
        },
        new Set([1]),
      ).map((r) => [r.code, r.where]),
    ).toEqual([
      ['SCENE_OUTSIDE_MENTIONS', 'scenes.1'],
      ['SCENE_OUTSIDE_MENTIONS', 'arc.stages.0'],
    ]);
    expect(
      mentionRemarks({ scenes: [{ chapter: 1, title: 'a', text: 'b' }] }, new Set([1])),
    ).toEqual([]);
  });
});

describe('pageRemarks: text checks', () => {
  // e2e F08-4a: фраза пути по эталону без точки считалась оборванной - каждая страница шла на переделку.
  it('arc.from and arc.to are phrases as in the sample: no break-off remark; a long text that breaks off has one', () => {
    const draft = readPageAnswer(
      {
        arc: { from: 'a proud loner bound to the town', to: 'free of it', stages: [] },
        character: 'Anna is restless and she looks past the town at the river and',
      },
      check,
    );
    expect(pageRemarks(draft, check, 'Anna').map((r) => [r.code, r.where.split(':')[0]])).toEqual([
      ['JUNK', 'character'],
    ]);
  });
});

describe('importRemarks: the DTO of the world import', () => {
  it('a field over the import limit - IMPORT_INVALID with its path; the block is not written', () => {
    const remarks = importRemarks('anna', 'Anna', { short: 'x'.repeat(601), character: 'Fine.' });
    expect(remarks.map((r) => [r.code, r.where])).toEqual([['IMPORT_INVALID', 'short']]);
    expect([...invalidBlocks(remarks)]).toEqual(['short']);
    expect(importRemarks('anna', 'Anna', { short: 'Fine.' })).toEqual([]);
  });
});

describe('external blocks: only with an opened source about the book', () => {
  const answer = {
    critique: { text: 'Critics read her as a rebel.', refs: [0] },
    prototypes: { text: 'A sister of the author.', refs: [1] },
    adaptations: [
      { title: 'Film', year: 0, actor: '', differences: 'Shorter.', refs: [2] },
      { title: 'Series', year: 1999, actor: 'Actor', differences: 'Longer.', refs: [0] },
    ],
    sources: [
      { title: 'About', url: 'https://about.test/a' },
      { title: 'Missing', url: 'https://missing.test/b' },
      { title: 'Soup', url: 'https://other.test/c' },
    ],
  };
  const checks = [
    { host: 'about.test', opened: true, text: 'Book en by Author.' },
    { host: 'missing.test', opened: false, text: '' },
    { host: 'other.test', opened: true, text: 'A recipe for soup.' },
  ];

  it('the year 0 of the strict form is «no year»', () => {
    expect(readExternalAnswer(answer).blocks.adaptations?.[0]).toEqual({
      title: 'Film',
      differences: 'Shorter.',
    });
  });

  it('a statement whose sources did not open or are not about the book is dropped; the kept ones carry their checked sources', () => {
    const verdict = verifyWorldExternal(
      'anna',
      readExternalAnswer(answer),
      checks,
      ['Book en'],
      ['Author'],
    );
    expect(verdict.blocks).toEqual({
      critique: 'Critics read her as a rebel.',
      adaptations: [{ title: 'Series', year: 1999, actor: 'Actor', differences: 'Longer.' }],
    });
    expect(verdict.unverified).toEqual(['prototypes']);
    expect(verdict.sourcesOf).toEqual({
      critique: [answer.sources[0]],
      adaptations: [answer.sources[0]],
    });
    expect(verdict.droppedAt).toEqual([1, 2]);
    expect(verdict.droppedSources.map((d) => [d.host, d.reason])).toEqual([
      ['missing.test', 'SOURCE_UNREACHABLE'],
      ['other.test', 'SOURCE_UNRELATED'],
    ]);
    expect(verdict.fixes.map((f) => [f.code, f.path])).toEqual(
      expect.arrayContaining([
        ['SOURCE_UNVERIFIED', 'prototypes'],
        ['SOURCE_UNVERIFIED', 'adaptations.0'],
      ]),
    );
    expect(externalChecks(verdict.blocks).map((r) => [r.code, r.where])).toEqual([
      ['EXTERNAL_CHECK', 'critique'],
      ['EXTERNAL_CHECK', 'adaptations'],
    ]);
  });

  it('every source open and about the book - nothing is dropped', () => {
    const all = checks.map((c) => ({ ...c, opened: true, text: 'Book en by Author.' }));
    const verdict = verifyWorldExternal(
      'anna',
      readExternalAnswer(answer),
      all,
      ['Book en'],
      ['Author'],
    );
    expect(verdict.unverified).toEqual([]);
    expect(verdict.fixes).toEqual([]);
  });
});

describe('remark codes of the world run', () => {
  it('every code the reviewer and the code checks may put is in the answer list (WORLD_REMARK_CODES)', () => {
    const own = new Set<string>(WORLD_REMARK_CODES);
    for (const code of [
      ...WORLD_REVIEW_CODES,
      'IMPORT_INVALID',
      'SCENE_OUTSIDE_MENTIONS',
      'EXTERNAL_CHECK',
      'LANGUAGE_MIXED',
      'NAME_MISMATCH',
      'JUNK',
    ]) {
      expect(own.has(code)).toBe(true);
    }
  });
});

/** Круг /fix 1 (/qa 17.11.2026): пределы импорта и формы имени из досье. */
describe('limits of the import on the name, the name forms and the sources', () => {
  const folded = foldedVersion(chapters);

  it('a name form over the import limit is dropped with IMPORT_INVALID; a name over the limit falls back to the analysis name', () => {
    const long = `Anna ${'x'.repeat(300)}`;
    const out = readSelectAnswer(
      { characters: [{ key: 'anna', name: long, aliases: ['Anna', long] }] },
      [{ key: 'anna', name: 'Anna' }],
      folded,
    );
    expect(out.characters).toEqual([{ key: 'anna', name: 'Anna', aliases: ['Anna'] }]);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([
      ['IMPORT_INVALID', 'characters.0.aliases.1'],
    ]);
    expect(readPageAnswer({ name: long }, check).name).toBeNull();
  });

  it('a source that is not an absolute https address is dropped; the refs keep pointing at the same sources', () => {
    const out = readExternalAnswer({
      critique: { text: 'Critics.', refs: [2] },
      prototypes: { text: 'A prototype.', refs: [0] },
      adaptations: [],
      sources: [
        { title: 'Bad', url: 'http://plain.test/a' },
        { title: 'Empty', url: '' },
        { title: 'Good', url: 'https://about.test/a' },
      ],
    });
    expect(out.sources).toEqual([{ title: 'Good', url: 'https://about.test/a' }]);
    // Ссылка на третий источник ответа - первый из оставшихся; ссылка на выброшенный - пусто.
    expect(out.refs.critique).toEqual([0]);
    expect(out.refs.prototypes).toEqual([]);
    expect(out.fixes.map((f) => [f.code, f.path])).toEqual([
      ['IMPORT_INVALID', 'sources.0'],
      ['IMPORT_INVALID', 'sources.1'],
    ]);
  });

  it('dossier and glossary forms join the name forms only when they stand in the text', () => {
    const dossier = {
      characters: [
        { key: 'anna', name: 'Anna', variants: ['Annushka'], address: [] },
        { key: 'boris', name: 'Boris', variants: [], address: [{ to: 'anna', form: 'Anna' }] },
      ],
    };
    const glossary = { entries: [{ key: 'anna', source: 'Анна', target: 'Anna' }] };
    expect(dossierForms({ key: 'anna', name: 'Anna' }, dossier, glossary, folded)).toEqual([
      'Anna',
    ]);
    expect(dossierForms({ key: 'boris', name: 'Boris' }, dossier, null, folded)).toEqual(['Boris']);
    expect(dossierForms({ key: 'nobody', name: 'Nobody' }, dossier, null, folded)).toEqual([]);
  });
});

// Решение арбитра `F08 | F08-4a`: ключ глоссария - ключ героя досье, у героя анализа он бывает другим.
describe('dossierForms: the glossary by the key of the dossier character', () => {
  it('a glossary entry with the dossier key gives its form when the analysis key differs; a form not in the text is dropped', () => {
    const folded = foldedVersion(chapters);
    const dossier = { characters: [{ key: 'anya', name: 'Anna', variants: [], address: [] }] };
    const glossary = {
      entries: [
        { key: 'anya', source: 'Анна', target: 'Anna' },
        { key: 'anya', source: 'Анечка', target: 'Annechka' },
      ],
    };
    expect(dossierForms({ key: 'anna', name: 'Anna' }, dossier, glossary, folded)).toEqual([
      'Anna',
    ]);
    const onlyGlossary = { characters: [{ key: 'anya', name: 'Ann', variants: [], address: [] }] };
    expect(dossierForms({ key: 'anna', name: 'Ann' }, onlyGlossary, glossary, folded)).toEqual([
      'Anna',
    ]);
  });
});

describe('pair step answer (F08-8e)', () => {
  const pairCheck: WorldPairCheck = {
    key: 'anna--boris',
    a: 'anna',
    b: 'boris',
    language: 'en',
    chapters,
    chaptersA: new Set([1]),
    chaptersB: new Set([2]),
    glossary: [],
    core: true,
  };
  const row = (chapterA: number, chapterB: number) => ({
    feature: 'Morning',
    a: 'Anna walks by the river.',
    chapterA,
    b: 'Boris rings the bell.',
    chapterB,
  });
  const pairQuote = (text: string, chapter: number, speakerKey: string, aboutKey: string) => ({
    text,
    chapter,
    speakerKey,
    aboutKey,
    interpretation: 'What the line shows.',
  });

  it('a compare row with a side chapter not of the version is removed; a row of the version stays', () => {
    const draft = readPairAnswer({ compare: [row(1, 2), row(1, 9), row(7, 2)] }, pairCheck);
    expect(draft.blocks.compare).toEqual([row(1, 2)]);
    expect(draft.fixes.map((f) => [f.code, f.path])).toEqual([
      ['CHAPTER_UNKNOWN', 'compare.1'],
      ['CHAPTER_UNKNOWN', 'compare.2'],
    ]);
  });

  it('a quote not word for word is dropped; a word-for-word line of one about the other stays', () => {
    const draft = readPairAnswer(
      {
        quotes: [
          pairQuote('the cold river at dawn', 1, 'anna', 'boris'),
          pairQuote('the warm sea at night', 1, 'anna', 'boris'),
        ],
      },
      pairCheck,
    );
    expect(draft.blocks.quotes?.map((q) => q.text)).toEqual(['the cold river at dawn']);
    expect(draft.droppedQuotes).toEqual([
      {
        key: 'anna--boris',
        chapter: 1,
        text: 'the warm sea at night',
        reason: 'QUOTE_NOT_VERBATIM',
      },
    ]);
  });

  it('a quote of a chapter not of the version or without a chapter is dropped with CHAPTER_UNKNOWN (F08-8e-5)', () => {
    const draft = readPairAnswer(
      {
        quotes: [
          pairQuote('the cold river at dawn', 9, 'anna', 'boris'),
          { ...pairQuote('the cold river at dawn', 1, 'anna', 'boris'), chapter: null },
          pairQuote('the cold river at dawn', 1, 'anna', 'boris'),
        ],
      },
      pairCheck,
    );
    expect(draft.blocks.quotes?.map((q) => q.chapter)).toEqual([1]);
    expect(draft.droppedQuotes).toEqual([
      { key: 'anna--boris', chapter: 9, text: 'the cold river at dawn', reason: 'CHAPTER_UNKNOWN' },
      {
        key: 'anna--boris',
        chapter: null,
        text: 'the cold river at dawn',
        reason: 'CHAPTER_UNKNOWN',
      },
    ]);
    expect(draft.fixes.map((f) => [f.code, f.path])).toEqual([
      ['CHAPTER_UNKNOWN', 'quotes.0'],
      ['CHAPTER_UNKNOWN', 'quotes.1'],
    ]);
  });

  it('a quote by or about someone else, about oneself or without aboutKey is removed: the import would refuse the pair', () => {
    const line = 'the old bell three times';
    const draft = readPairAnswer(
      {
        quotes: [
          pairQuote(line, 2, 'tom', 'anna'),
          pairQuote(line, 2, 'boris', 'boris'),
          pairQuote(line, 2, 'boris', ''),
          pairQuote(line, 2, 'boris', 'anna'),
        ],
      },
      pairCheck,
    );
    expect(draft.blocks.quotes).toEqual([pairQuote(line, 2, 'boris', 'anna')]);
    expect(draft.fixes.map((f) => [f.code, f.path])).toEqual([
      ['KEY_UNKNOWN', 'quotes.0'],
      ['KEY_UNKNOWN', 'quotes.1'],
      ['KEY_UNKNOWN', 'quotes.2'],
    ]);
  });

  it('no sources, external blocks or hero fields in the pair draft, whatever the answer holds', () => {
    const draft = readPairAnswer(
      {
        short: 'Two.',
        sources: [{ title: 't', url: 'https://x.example' }],
        critique: 'c',
        role: 'main',
      },
      pairCheck,
    );
    expect(Object.keys(draft.blocks)).toEqual(['short']);
  });

  it('the core (Q5): no short, fewer than 4 full rows, no conclusion - CORE_MISSING; the full core - none', () => {
    expect(pairCoreRemarks({ compare: [row(1, 2)] }).map((r) => r.where)).toEqual([
      'short',
      'compare',
      'conclusion',
    ]);
    expect(
      pairCoreRemarks({
        short: 'Two.',
        compare: [1, 2, 3, 4].map(() => row(1, 2)),
        conclusion: 'So.',
      }),
    ).toEqual([]);
  });

  it('a side outside the chapters of its character - SCENE_OUTSIDE_MENTIONS on that side', () => {
    const draft = readPairAnswer({ compare: [row(2, 2), row(1, 1)] }, pairCheck);
    const outside = pairRemarks(draft, pairCheck, 'Anna and Boris')
      .filter((r) => r.code === 'SCENE_OUTSIDE_MENTIONS')
      .map((r) => r.where);
    expect(outside).toEqual(['compare.0.chapterA', 'compare.1.chapterB']);
  });

  it('import remarks of a pair go by the pair DTO: no role needed; a pair block over its limit is IMPORT_INVALID', () => {
    const ok = importRemarks('anna--boris', 'Anna and Boris', { conclusion: 'So.' }, 'pair');
    expect(ok).toEqual([]);
    const long = importRemarks(
      'anna--boris',
      'Anna and Boris',
      { conclusion: 'x'.repeat(5000) },
      'pair',
    );
    expect(long.map((r) => [r.code, r.where])).toEqual([['IMPORT_INVALID', 'conclusion']]);
  });

  it('the core: 3 full rows or 4 rows with one not full - CORE_MISSING on compare', () => {
    const full = { short: 'Two.', conclusion: 'So.' };
    expect(
      pairCoreRemarks({ ...full, compare: [1, 2, 3].map(() => row(1, 2)) }).map((r) => r.where),
    ).toEqual(['compare']);
    const notFull = [...[1, 2, 3].map(() => row(1, 2)), { ...row(1, 2), b: '' }];
    expect(pairCoreRemarks({ ...full, compare: notFull }).map((r) => r.where)).toEqual(['compare']);
  });

  it('regenerating one block of a pair (core: false): no CORE_MISSING for the blocks the answer does not hold', () => {
    const draft = readPairAnswer({ bonds: 'Both grew up by the river.' }, pairCheck);
    const codes = (core: boolean) =>
      pairRemarks(draft, { ...pairCheck, core }, 'Anna and Boris').map((r) => r.code);
    expect(codes(true)).toContain('CORE_MISSING');
    expect(codes(false)).not.toContain('CORE_MISSING');
  });
});
