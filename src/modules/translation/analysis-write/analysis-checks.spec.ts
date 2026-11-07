import { EMPTY_BOOK_ANALYSIS } from '../../book-analysis/book-analysis-data';
import { indexChapters } from '../draft-quality/quote-check';
import { ANALYSIS_REMARK_CODES, SUMMARY_REMARK_CODES } from '../draft-quality/text-checks';
import {
  coreRemark,
  fixDraft,
  importRemarks,
  innerQuoteRemarks,
  stepRemarks,
  textRemarks,
} from './analysis-checks';
import { STEP_FIX_CODES } from './analysis-write.data';
import { externalChecks } from './analysis-write.external';
import { ANALYSIS_REVIEW_CODES } from './analysis-write.prompts';

/**
 * Код-проверки хода анализа (`features/F07-analysis-autofill/tech.md` §3; решение арбитра
 * `F07 | F07-1`, В3): каждая краснеет на своём входе. Правки без переделки - выброс, снятие,
 * обрезка с причиной; замечания с переделкой - `IMPORT_INVALID` с путём поля, язык, имена, мусор.
 */

const CHAPTERS = indexChapters(
  new Map([
    [1, 'Anna walked along the cold river at dawn.\n\n“I will never come back,” said Anna.'],
    [2, 'The bell rang over the empty square three times.'],
  ]),
);

describe('fixDraft', () => {
  it('QUOTE_NOT_VERBATIM: an invented key quotation is dropped with its reason, a true one keeps the chapter text', () => {
    const { blocks, droppedQuotes } = fixDraft(
      {
        keyQuotes: [
          { text: '"I will never come back," said Anna.', chapter: 1, interpretation: 'x' },
          { text: 'Anna flew over the mountains.', chapter: 1 },
          { text: 'The bell rang over the empty square', chapter: 1 },
        ],
      },
      CHAPTERS,
    );
    expect(blocks.keyQuotes).toEqual([
      { text: '“I will never come back,” said Anna.', chapter: 1, interpretation: 'x' },
    ]);
    expect(droppedQuotes).toEqual([
      {
        path: 'keyQuotes.1',
        text: 'Anna flew over the mountains.',
        chapter: 1,
        reason: 'NOT_FOUND',
      },
      {
        path: 'keyQuotes.2',
        text: 'The bell rang over the empty square',
        chapter: 1,
        reason: 'NOT_FOUND',
      },
    ]);
  });

  it('QUOTE_NOT_VERBATIM in every place: characters, themes, symbols, style - the element stays, the quotation goes', () => {
    const fake = { text: 'Not in the book at all.', chapter: 2 };
    const { blocks, droppedQuotes } = fixDraft(
      {
        characters: [{ key: 'anna', name: 'Anna', role: 'main', quote: fake }],
        themes: [{ key: 'loss', title: 'Loss', quotes: [{ ...fake, comment: 'c' }] }],
        symbols: [{ title: 'Bell', interpretation: 'i', quote: { text: 'x', chapter: 9 } }],
        style: [{ device: 'Repetition', explanation: 'e', example: { text: 'bell rang' } }],
      },
      CHAPTERS,
    );
    expect(blocks.characters).toEqual([{ key: 'anna', name: 'Anna', role: 'main' }]);
    expect(blocks.themes).toEqual([{ key: 'loss', title: 'Loss' }]);
    expect(blocks.symbols).toEqual([{ title: 'Bell', interpretation: 'i' }]);
    expect(blocks.style).toEqual([{ device: 'Repetition', explanation: 'e' }]);
    expect(droppedQuotes.map((d) => [d.path, d.reason])).toEqual([
      ['characters.anna.quote', 'NOT_FOUND'],
      ['style.0.example', 'NO_CHAPTER'],
      ['themes.loss.quotes.0', 'NOT_FOUND'],
      ['symbols.0.quote', 'CHAPTER_MISSING'],
    ]);
  });

  it('CHAPTER_UNKNOWN: a chapter number not in the version is removed, the element stays', () => {
    const { blocks, fixes } = fixDraft(
      {
        themes: [{ key: 'loss', title: 'Loss', chapters: [1, 7, 2] }],
        symbols: [{ title: 'Bell', interpretation: 'i', chapters: [9] }],
      },
      CHAPTERS,
    );
    expect(blocks.themes).toEqual([{ key: 'loss', title: 'Loss', chapters: [1, 2] }]);
    expect(blocks.symbols).toEqual([{ title: 'Bell', interpretation: 'i' }]);
    expect(fixes.map((f) => [f.code, f.path])).toEqual([
      ['CHAPTER_UNKNOWN', 'themes.loss.chapters'],
      ['CHAPTER_UNKNOWN', 'symbols.0.chapters'],
    ]);
  });

  it('LIMIT_OUT: the tail over the import limit is cut with the reason; fewer is not a flag', () => {
    const themes = Array.from({ length: 10 }, (_, i) => ({ key: `t${i}`, title: `T${i}` }));
    const { blocks, fixes } = fixDraft({ themes }, CHAPTERS);
    expect(blocks.themes?.map((t) => t.key)).toEqual([
      't0',
      't1',
      't2',
      't3',
      't4',
      't5',
      't6',
      't7',
    ]);
    expect(fixes).toEqual([
      { code: 'LIMIT_OUT', path: 'themes', note: '2 of 10 cut: the import takes at most 8' },
    ]);
    expect(fixDraft({ themes: themes.slice(0, 1) }, CHAPTERS).fixes).toEqual([]);
  });

  it('a list left empty after the fixes is not sent: [] would clear the block (Л4)', () => {
    const { blocks } = fixDraft(
      { keyQuotes: [{ text: 'Invented line here.', chapter: 1 }] },
      CHAPTERS,
    );
    expect('keyQuotes' in blocks).toBe(false);
  });
});

describe('importRemarks', () => {
  it('IMPORT_INVALID: the DTO of the import fails - the path of the field', () => {
    const remarks = importRemarks(
      'en',
      EMPTY_BOOK_ANALYSIS,
      {},
      {
        characters: [{ key: 'Anna Bad', name: 'Anna', role: 'main' }],
      },
    );
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ code: 'IMPORT_INVALID', by: 'code' });
    expect(remarks[0].where).toBe('characters.0.key');
  });

  it('IMPORT_INVALID: the refs are checked on the merged object - a speaker of the previous step passes, an unknown one fails', () => {
    const merged = { characters: [{ key: 'anna', name: 'Anna', role: 'main' as const }] };
    expect(
      importRemarks('en', EMPTY_BOOK_ANALYSIS, merged, {
        keyQuotes: [{ text: 'Quote', speakerKey: 'anna' }],
      }),
    ).toEqual([]);
    const remarks = importRemarks('en', EMPTY_BOOK_ANALYSIS, merged, {
      keyQuotes: [{ text: 'Quote', speakerKey: 'boris' }],
    });
    expect(remarks.map((r) => r.where)).toEqual(['keyQuotes.0.speakerKey']);
  });

  it('a saved character is a valid speaker too: the stored analysis is under the merge', () => {
    const stored = {
      ...EMPTY_BOOK_ANALYSIS,
      characters: [{ key: 'boris', name: 'Boris', role: 'secondary' as const }],
    };
    expect(
      importRemarks('en', stored, {}, { keyQuotes: [{ text: 'Quote', speakerKey: 'boris' }] }),
    ).toEqual([]);
  });
});

describe('textRemarks', () => {
  it('a short field: Markdown is JUNK, no final full stop is not (Р10)', () => {
    const markdown = textRemarks({ facts: { settingPlace: '**Petersburg**' } }, 'en', []);
    expect(markdown.map((r) => [r.code, r.where])).toEqual([
      ['JUNK', 'facts.settingPlace: markdown'],
    ]);
    expect(textRemarks({ facts: { settingPlace: 'Petersburg' } }, 'en', [])).toEqual([]);
  });

  it('JUNK in a long field: Markdown and a broken-off sentence; a short field is a phrase, not JUNK', () => {
    const remarks = textRemarks(
      {
        facts: { settingPlace: 'Petersburg' },
        mainIdea: 'The novel asks **whether** a man may cross the line',
      },
      'en',
      [],
    );
    expect(remarks.map((r) => r.code)).toEqual(['JUNK', 'JUNK']);
    expect(remarks.every((r) => r.where.startsWith('mainIdea: '))).toBe(true);
  });

  it('NAME_MISMATCH: the original form of a glossary name in a description', () => {
    const remarks = textRemarks(
      {
        characters: [
          { key: 'anna', name: 'Annette', role: 'main', description: 'Anna leaves the town.' },
        ],
      },
      'fr',
      [{ key: 'anna', source: 'Anna', target: 'Annette', keepOriginal: false }],
    );
    expect(remarks.map((r) => [r.code, r.where.split(':')[0]])).toEqual([
      ['NAME_MISMATCH', 'characters.anna.description'],
    ]);
  });

  it('LANGUAGE_MIXED: a paragraph in another language than the version', () => {
    const remarks = stepRemarks({
      language: 'en',
      stored: EMPTY_BOOK_ANALYSIS,
      merged: {},
      glossary: [],
      chapters: CHAPTERS,
      draft: {
        blocks: {
          mainIdea:
            'Anna quitte la maison le matin et marche vers la gare avec son vieux frère. Ils ' +
            'attendent le train pendant longtemps et parlent du passé et des gens qu’ils ont ' +
            'connus quand ils étaient jeunes et quand la maison était encore pleine de vie.',
        },
        themeLinks: null,
        droppedQuotes: [],
        fixes: [],
      },
    });
    expect(remarks.map((r) => r.code)).toContain('LANGUAGE_MIXED');
  });
});

describe('innerQuoteRemarks (F07-5)', () => {
  it('a quotation inside an interpretation not in any chapter - QUOTE_NOT_VERBATIM at the field path, the text is kept', () => {
    const blocks = {
      themes: [
        {
          key: 'home',
          title: 'Home',
          interpretation: 'Anna swears «she will burn the house» and leaves.',
        },
      ],
    };
    const remarks = innerQuoteRemarks(blocks, CHAPTERS);
    expect(remarks.map((r) => [r.code, r.by, r.where.split(':')[0]])).toEqual([
      ['QUOTE_NOT_VERBATIM', 'code', 'themes.home.interpretation'],
    ]);
    expect(blocks.themes[0].interpretation).toContain('«she will burn the house»');
  });

  it('a verbatim quotation of two words and more passes in a description; reader-step questions and answers are not checked at all', () => {
    const blocks = {
      characters: [
        {
          key: 'anna',
          name: 'Anna',
          role: 'main' as const,
          description: 'She says «never come back».',
        },
      ],
      discussionQuestions: ['Why does «the bell» ring «three times»?'],
      faq: [{ question: 'q', answer: 'At dawn, by «the cold river».' }],
    };
    expect(innerQuoteRemarks(blocks, CHAPTERS)).toEqual([]);
  });

  it('a two-word quotation not in the text is a remark; one word in quotation marks is not a quotation', () => {
    const remarks = innerQuoteRemarks(
      { mainIdea: 'The river «will act» on its own; Anna is «free».' },
      CHAPTERS,
    );
    expect(remarks.map((r) => r.where.split(':')[0])).toEqual(['mainIdea']);
  });

  it('the reader step (questions, misreadings, FAQ) is written from chapter summaries - its quotations are not checked against the book', () => {
    const blocks = {
      discussionQuestions: ['Who «sees nothing» here?'],
      misreadings: [
        { myth: 'It is «a sad story».', explanation: 'Calling it «a sad story» misses the dawn.' },
      ],
      faq: [{ question: 'q', answer: 'Because «the river burns».' }],
    };
    expect(innerQuoteRemarks(blocks, CHAPTERS)).toEqual([]);
  });

  it('marks at the edges of a quotation and an insertion in brackets are not compared', () => {
    expect(
      innerQuoteRemarks({ mainIdea: 'He calls it «walked along the cold river,» then.' }, CHAPTERS),
    ).toEqual([]);
    expect(
      innerQuoteRemarks({ mainIdea: 'She «[Anna] walked along the cold river».' }, CHAPTERS),
    ).toEqual([]);
  });

  it('pieces around an elision keep their order; an ellipsis of the book itself in an exact quotation passes', () => {
    expect(innerQuoteRemarks({ mainIdea: 'She «at dawn … walked along».' }, CHAPTERS)).toHaveLength(
      1,
    );
    const chapters = indexChapters(new Map([[1, 'Dijo: Bueno… ya veremos mañana.']]));
    expect(innerQuoteRemarks({ mainIdea: 'Y él: «Bueno… ya veremos».' }, chapters)).toEqual([]);
  });

  it('a quotation after an elided article is found; a text in NFD is found', () => {
    const chapters = indexChapters(
      new Map([[1, "C'est l'homme qui rit, au café, à midi.".normalize('NFD')]]),
    );
    expect(innerQuoteRemarks({ mainIdea: 'Il est «homme qui rit» ici.' }, chapters)).toEqual([]);
    expect(innerQuoteRemarks({ mainIdea: 'Il «rit, au café» ici.' }, chapters)).toEqual([]);
    expect(innerQuoteRemarks({ mainIdea: 'Il «rit au bar» ici.' }, chapters)).toHaveLength(1);
  });

  it('the external step and names are not checked against the book; no chapters - no remarks', () => {
    const external = {
      context: 'Critics called it «a hymn to the river».',
      reception: 'Reviewers wrote «a quiet masterpiece».',
      timeline: [{ kind: 'book' as const, year: '1899', event: 'Printed as «a long tale».' }],
      adaptations: [
        {
          kind: 'film' as const,
          year: 1979,
          title: '«Dark River» film',
          differences: 'A «new war» frame.',
        },
      ],
      sources: [{ url: 'https://example.org/a', title: '«River Book» page' }],
    };
    expect(innerQuoteRemarks(external, CHAPTERS)).toEqual([]);
    expect(innerQuoteRemarks({ mainIdea: 'Anna «will burn it».' }, new Map())).toEqual([]);
  });

  it('a device, an arc, a relation label, a name and a title are short fields - not book quotations (the myth is a reader-step field)', () => {
    const blocks = {
      misreadings: [
        { myth: 'Readers call it «a sad story».', explanation: 'At dawn, by the river.' },
      ],
      style: [{ device: '«stream of consciousness»', explanation: 'Short lines.' }],
      characters: [
        {
          key: 'anna',
          name: '«Little Anna» Grey',
          role: 'main' as const,
          description: 'Walks.',
          arc: { from: 'a «lost girl»', to: 'a «free woman»' },
          relations: [{ to: 'anna', label: '«old friend»' }],
        },
      ],
      themes: [{ key: 'home', title: '«Home and road»', interpretation: 'The road.' }],
    };
    expect(innerQuoteRemarks(blocks, CHAPTERS)).toEqual([]);
  });

  it('whole words only: two words found inside longer words are not the quotation', () => {
    const remarks = innerQuoteRemarks(
      { mainIdea: 'Anna walks «the col» of the morning.' },
      CHAPTERS,
    );
    expect(remarks.map((r) => r.code)).toEqual(['QUOTE_NOT_VERBATIM']);
  });

  it('an elided quotation passes when every piece stands in one paragraph; a changed piece is a remark', () => {
    expect(
      innerQuoteRemarks({ mainIdea: 'She «walked along… at dawn», alone.' }, CHAPTERS),
    ).toEqual([]);
    expect(
      innerQuoteRemarks({ mainIdea: 'She «walked along [...] at night», alone.' }, CHAPTERS),
    ).toHaveLength(1);
    // Куски из разных абзацев - не одна цитата.
    expect(
      innerQuoteRemarks({ mainIdea: 'She «walked along … said Anna».' }, CHAPTERS),
    ).toHaveLength(1);
  });

  it('the title of the book or of a chapter in quotation marks is not a quotation', () => {
    const blocks = { titleMeaning: 'The title «The Dark River» and the chapter «At the Square».' };
    expect(innerQuoteRemarks(blocks, CHAPTERS)).toHaveLength(2);
    expect(innerQuoteRemarks(blocks, CHAPTERS, ['The Dark River', 'at the square'])).toEqual([]);
  });

  it('stepRemarks carries the quotation remark, so the step is redone', () => {
    const remarks = stepRemarks({
      language: 'en',
      stored: EMPTY_BOOK_ANALYSIS,
      merged: {},
      glossary: [],
      chapters: CHAPTERS,
      draft: {
        blocks: { titleMeaning: 'The title means «the dark heart of the river» itself.' },
        themeLinks: null,
        droppedQuotes: [],
        fixes: [],
      },
    });
    expect(remarks.map((r) => r.code)).toContain('QUOTE_NOT_VERBATIM');
  });
});

describe('coreRemark', () => {
  it('CORE_MISSING (К5): by the saved analysis - no themes written - a flag with what is missing', () => {
    const remark = coreRemark({ ...EMPTY_BOOK_ANALYSIS, mainIdea: 'Idea.' });
    expect(remark).toMatchObject({ code: 'CORE_MISSING', by: 'code', where: 'core' });
    expect(remark?.note).toContain('themes 0 of 2');
  });

  it('the saved analysis has the core - no flag', () => {
    const merged = {
      characters: [
        { key: 'a', name: 'A', role: 'main' as const, description: 'd' },
        { key: 'b', name: 'B', role: 'secondary' as const, description: 'd' },
      ],
      keyQuotes: ['1', '2', '3'].map((text) => ({ text, interpretation: 'i' })),
    };
    const step3 = {
      mainIdea: 'Idea.',
      themes: [
        { key: 'x', title: 'X', interpretation: 'i' },
        { key: 'y', title: 'Y', interpretation: 'i' },
      ],
    };
    expect(coreRemark({ ...EMPTY_BOOK_ANALYSIS, ...merged, ...step3 })).toBeNull();
  });
});

describe('ANALYSIS_REMARK_CODES (А4)', () => {
  it('every code the analysis run can set is in the list, and nothing else: code checks, fixes, CORE_MISSING and the analysis reviewer', () => {
    const french =
      'Anna quitte la maison le matin et marche vers la gare avec son vieux frère. Ils ' +
      'attendent le train pendant longtemps et parlent du passé et des gens qu’ils ont ' +
      'connus quand ils étaient jeunes et quand la maison était encore pleine de vie.';
    const checks = [
      ...stepRemarks({
        language: 'en',
        stored: EMPTY_BOOK_ANALYSIS,
        merged: {},
        glossary: [],
        chapters: CHAPTERS,
        draft: {
          blocks: {
            characters: [{ key: 'Anna Bad', name: 'Anna', role: 'main' }],
            mainIdea: french,
            titleMeaning: 'Anna swears «she will burn the house» at dawn.',
            facts: { settingPlace: '**Petersburg**' },
          },
          themeLinks: null,
          droppedQuotes: [],
          fixes: [],
        },
      }),
      ...textRemarks(
        {
          characters: [
            { key: 'anna', name: 'Annette', role: 'main', description: 'Anna leaves the town.' },
          ],
        },
        'fr',
        [{ key: 'anna', source: 'Anna', target: 'Annette', keepOriginal: false }],
      ),
      coreRemark(EMPTY_BOOK_ANALYSIS),
      ...externalChecks({ context: 'Epoch.', facts: { genre: 'novel' } }),
    ].flatMap((r) => (r ? [r.code] : []));
    expect(new Set(checks)).toEqual(
      new Set([
        'IMPORT_INVALID',
        'LANGUAGE_MIXED',
        'JUNK',
        'NAME_MISMATCH',
        'QUOTE_NOT_VERBATIM',
        'CORE_MISSING',
        'EXTERNAL_CHECK',
      ]),
    );
    const can = new Set<string>([...checks, ...STEP_FIX_CODES, ...ANALYSIS_REVIEW_CODES]);
    const list = new Set<string>(ANALYSIS_REMARK_CODES);
    expect([...can].filter((code) => !list.has(code))).toEqual([]);
    expect([...list].filter((code) => !can.has(code))).toEqual([]);
    // Кодов пересказа, которых анализ не ставит, в перечне нет.
    for (const code of ['LENGTH_OUT', 'EVENT_MISSING', 'EXTERNAL_FACT', 'ORDER_BROKEN'] as const) {
      expect(SUMMARY_REMARK_CODES).toContain(code);
      expect(list.has(code)).toBe(false);
    }
  });
});
