import { parallelChapters } from '../../../common/testing/language-corpus';
import { RICH_HTML_MAX_LENGTH } from '../../../shared/validators/rich-html.decorator';
import { checkMetadata, metadataFormErrors } from './metadata-check';
import { MetadataAnswer } from './metadata.prompts';
import { metadataInputOf, MetadataSourceFields } from './metadata-step';

/** Описание - два абзаца параллельной главы корпуса: исходник `en`, перевод `es`. */
function paragraphs(language: 'en' | 'es'): string[] {
  const lines = parallelChapters(language)[0].split('\n');
  const half = Math.floor(lines.length / 2);
  return [lines.slice(0, half).join(' '), lines.slice(half).join(' ')];
}

const FIELDS: MetadataSourceFields = {
  sourceLanguage: 'en',
  targetLanguage: 'es',
  title: 'The Old Man and the Long Road Home',
  author: 'John Smith',
  description: paragraphs('en')
    .map((p) => `<p>${p}</p>`)
    .join(''),
  chapterTitles: [
    { number: 1, title: 'The Beginning' },
    { number: 2, title: '' },
  ],
};

const GLOSSARY = {
  entries: [
    {
      key: 'author',
      source: 'John Smith',
      target: 'Juan Herrero',
      kind: 'person',
      keepOriginal: false,
      note: '',
    },
  ],
  address: [],
  phrases: [],
};

function source(fields: MetadataSourceFields = FIELDS, glossary: unknown = GLOSSARY) {
  return metadataInputOf(fields, { glossary, dossier: null }).source;
}

function answer(overrides: Partial<MetadataAnswer> = {}): MetadataAnswer {
  return {
    title: 'El viejo y el largo camino a casa',
    author: 'Juan Herrero',
    description: paragraphs('es').map((text, i) => ({ n: i + 1, text })),
    chapterTitles: [
      { number: 1, title: 'El comienzo' },
      { number: 2, title: '' },
    ],
    ...overrides,
  };
}

function remarks(a: MetadataAnswer, s = source()): string[] {
  const checked = checkMetadata(s, a);
  return checked.ok ? [] : checked.remarks;
}

describe('checkMetadata', () => {
  it('accepts a translation in the target language with the glossary author', () => {
    const checked = checkMetadata(source(), answer());
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.result).toMatchObject({
      title: 'El viejo y el largo camino a casa',
      author: 'Juan Herrero',
      authorFromGlossary: true,
      chapterTitles: [
        { number: 1, title: 'El comienzo' },
        { number: 2, title: '' },
      ],
    });
    expect(checked.result.description.startsWith('<p>')).toBe(true);
  });

  it('a title left in the source language fails', () => {
    const title = 'The man who was in the house of the old woman';
    expect(remarks(answer({ title }))).toEqual([
      'The title is not in Spanish: it reads as English.',
    ]);
  });

  it('a chapter title left in the source language fails', () => {
    const titles = [
      { number: 1, title: 'The man who was in the house of the old woman' },
      { number: 2, title: '' },
    ];
    expect(remarks(answer({ chapterTitles: titles }))).toEqual([
      expect.stringContaining('Chapter titles 1 are not in Spanish'),
    ]);
  });

  it('a short title the detector is unsure about passes', () => {
    expect(checkMetadata(source(), answer({ title: 'Ulises' })).ok).toBe(true);
  });

  it('a description left in the source language fails by the piece checks', () => {
    const english = paragraphs('en').map((text, i) => ({ n: i + 1, text }));
    expect(remarks(answer({ description: english }))).toEqual([
      expect.stringMatching(/^Description: The translation is not in Spanish/),
    ]);
  });

  it('a title shorter than the manual minimum fails', () => {
    expect(remarks(answer({ title: 'X' }))).toEqual([
      'The title must be at least 2 characters long.',
    ]);
  });

  it('an author longer than the manual maximum fails', () => {
    expect(remarks(answer({ author: 'J'.repeat(501) }), source(FIELDS, null))).toEqual([
      'The author name must be at most 500 characters long.',
    ]);
  });

  it('the author in the glossary must keep its glossary form', () => {
    expect(remarks(answer({ author: 'Juan Smith' }))).toEqual([
      'The author name must be exactly the glossary form: Juan Herrero.',
    ]);
  });

  it('an author missing from the glossary takes the model form and is marked as such', () => {
    const checked = checkMetadata(source(FIELDS, null), answer({ author: 'Yon Smit' }));
    expect(checked.ok && checked.result).toMatchObject({
      author: 'Yon Smit',
      authorFromGlossary: false,
    });
  });

  it('a source without an author has nothing to check against the glossary: null, not false', () => {
    for (const author of ['  ', '<b> </b>']) {
      const checked = checkMetadata(source({ ...FIELDS, author }), answer({ author: '' }));
      expect(checked.ok && checked.result).toMatchObject({ author: '', authorFromGlossary: null });
    }
  });

  it('a name the model gave to a source without an author is marked as not from the glossary', () => {
    const checked = checkMetadata(source({ ...FIELDS, author: '' }), answer({ author: 'Esopo' }));
    expect(checked.ok && checked.result).toMatchObject({
      author: 'Esopo',
      authorFromGlossary: false,
    });
  });

  it('an empty chapter title for a titled source chapter fails; an untitled one stays empty', () => {
    const titles = [
      { number: 1, title: ' ' },
      { number: 2, title: '' },
    ];
    expect(remarks(answer({ chapterTitles: titles }))).toEqual([
      'Chapter titles 1 came back empty. Translate every title.',
    ]);
  });

  it('a forbidden tag of the description is cleaned out', () => {
    const description = answer().description.map((b, i) =>
      i === 0 ? { n: b.n, text: `${b.text}<script>alert(1)</script>` } : b,
    );
    const checked = checkMetadata(source(), answer({ description }));
    expect(checked.ok && checked.result.description).not.toContain('script');
  });

  it('a description longer than the manual limit fails', () => {
    const long = { ...FIELDS, description: '<p>Short.</p>' };
    const description = [{ n: 1, text: 'palabra '.repeat(RICH_HTML_MAX_LENGTH.text / 8 + 1) }];
    expect(remarks(answer({ description }), source(long))).toEqual(
      expect.arrayContaining([expect.stringMatching(/^The description is \d+ characters long/)]),
    );
  });
});

describe('checkMetadata: the description takes only the language of the piece checks', () => {
  it('a description much longer than the source is not a failure (no length corridor)', () => {
    const description = answer().description.map((b) => ({ n: b.n, text: `${b.text} ${b.text}` }));
    expect(checkMetadata(source(), answer({ description })).ok).toBe(true);
  });
});

describe('metadataFormErrors', () => {
  const DESCRIPTION = metadataInputOf(FIELDS, { glossary: GLOSSARY, dossier: null }).input
    .description;

  it('description blocks and chapter numbers must be exactly those of the source', () => {
    const value = answer({
      description: [{ n: 1, text: 'uno' }],
      chapterTitles: [
        { number: 1, title: 'a' },
        { number: 1, title: 'b' },
        { number: 7, title: 'c' },
      ],
    });
    expect(metadataFormErrors(value, DESCRIPTION, [1, 2])).toEqual([
      '$.description: missing blocks 2',
      '$.chapterTitles: chapter 1 is repeated',
      '$.chapterTitles: chapter 7 is not in the book',
      '$.chapterTitles: missing chapters 2',
    ]);
  });

  it('an answer by the source is clean', () => {
    expect(metadataFormErrors(answer(), DESCRIPTION, [1, 2])).toEqual([]);
  });

  it('a description block that the markup whitelist empties goes back to the model', () => {
    const value = answer({
      description: [
        { n: 1, text: '<em></em>' },
        { n: 2, text: 'dos' },
      ],
    });
    expect(metadataFormErrors(value, DESCRIPTION, [1, 2])).toEqual([
      '$.description: blocks 1 are empty after removing markup; keep only inline tags',
    ]);
  });
});
