import { indexChapters } from './quote-check';
import {
  blocksOf,
  checkDuplicate,
  checkJunk,
  checkLanguage,
  checkNames,
  checkQuotes,
  DraftRemark,
  isSubheading,
  JUNK_PHRASES,
  QUOTE_MIN_WORDS,
  wordCount,
} from './text-checks';

/**
 * Код-проверки чистовика (`F06-1`; `features/F06-summary-autofill/product.md` §3): каждая краснеет
 * на своём испорченном входе и молчит на чистом.
 */

const codes = (remarks: readonly DraftRemark[]) => remarks.map((r) => r.code);

const CHAPTERS = indexChapters(
  new Map([
    [1, 'Anna opened the door and said: «I will never come back to this house.»'],
    [2, 'The rain did not stop for three days and three nights.'],
  ]),
);

describe('QUOTE_NOT_VERBATIM', () => {
  it('a quotation of five words or more found in any chapter of the set passes, without a chapter number', () => {
    const text =
      'Anna leaves. «I will never come back to this house.» The rain «did not stop for three days».';
    const { remarks, verbatim } = checkQuotes(text, CHAPTERS);
    expect(remarks).toEqual([]);
    expect(verbatim).toEqual([
      'I will never come back to this house.',
      'did not stop for three days',
    ]);
  });

  it('by default the summary check keeps its rules: five words and case (F07-5 options are opt-in)', () => {
    expect(checkQuotes('He said «rain did not stop».', CHAPTERS).remarks).toEqual([]);
    expect(codes(checkQuotes('«THE RAIN DID NOT STOP for three days»', CHAPTERS).remarks)).toEqual([
      'QUOTE_NOT_VERBATIM',
    ]);
  });

  it('minWords and matches replace the threshold and the search', () => {
    const seen: string[] = [];
    const matches = (quote: string) => {
      seen.push(quote);
      return quote === 'two words';
    };
    const { remarks, verbatim } = checkQuotes('A «two words» and «three more words».', matches, {
      minWords: 2,
    });
    expect(seen).toEqual(['two words', 'three more words']);
    expect(verbatim).toEqual(['two words']);
    expect(codes(remarks)).toEqual(['QUOTE_NOT_VERBATIM']);
  });

  it('a changed word in a quotation of five words is a remark', () => {
    const { remarks } = checkQuotes('She says «I shall never come back here».', CHAPTERS);
    expect(codes(remarks)).toEqual(['QUOTE_NOT_VERBATIM']);
    expect(remarks[0].by).toBe('code');
  });

  it('text in quotation marks shorter than five words is a name, not a quotation', () => {
    expect(checkQuotes('The ship «Morning Star» sails.', CHAPTERS).remarks).toEqual([]);
    expect(checkQuotes('He calls her "the little one" again.', CHAPTERS).remarks).toEqual([]);
  });

  it(`the border is ${QUOTE_MIN_WORDS} words: four invented words pass, five are a remark`, () => {
    expect(checkQuotes('She says «we shall see again».', CHAPTERS).remarks).toEqual([]);
    expect(codes(checkQuotes('She says «we shall see it again».', CHAPTERS).remarks)).toEqual([
      'QUOTE_NOT_VERBATIM',
    ]);
  });

  it('a stray straight quote does not pair with a quote in another paragraph', () => {
    const text =
      'The board is 5" wide and Anna keeps it.\n\nLater she says "yes" and leaves the town.';
    expect(checkQuotes(text, CHAPTERS).remarks).toEqual([]);
  });
});

describe('DUPLICATE_TEXT', () => {
  const section =
    'Anna walks through the empty house at night and listens to the rain on the old roof above her.';

  it('twelve words in a row repeating a section is a remark', () => {
    const full = `At night Anna walks through the empty house at night and listens to the rain on the old roof. Then she sleeps.`;
    expect(codes(checkDuplicate(full, [{ label: 'section 1', text: section }]))).toEqual([
      'DUPLICATE_TEXT',
    ]);
  });

  it('eleven words in a row are not a duplicate', () => {
    const full = 'Later Anna walks through the empty house at night and listens to music.';
    expect(checkDuplicate(full, [{ label: 'section 1', text: section }])).toEqual([]);
  });

  it('a verbatim quotation of the book repeated in both texts does not count', () => {
    const quote = 'I will never come back to this house, not tomorrow and not ever again.';
    const a = `Anna stands at the door. «${quote}» She leaves.`;
    const b = `The story turns when Anna says «${quote}» and goes away.`;
    expect(codes(checkDuplicate(a, [{ label: 'full', text: b }]))).toEqual(['DUPLICATE_TEXT']);
    expect(checkDuplicate(a, [{ label: 'full', text: b }], [quote])).toEqual([]);
  });

  it('a hyphenated word is one word in a run, as in the word count (F06-2, хвост F06-1)', () => {
    // Одиннадцать слов по `wordCount`: «well-known» - одно слово. Токенизатор без дефиса видел
    // бы двенадцать и поднял бы дубль на серии короче порога.
    const run = 'Anna walks through the well-known empty house and listens at night';
    expect(wordCount(run)).toBe(11);
    expect(checkDuplicate(run, [{ label: 'section 1', text: `Later ${run} again.` }])).toEqual([]);
  });
});

describe('JUNK', () => {
  it('a service phrase of the model is a remark; a clean text is silent', () => {
    expect(
      codes(checkJunk('Sure, here is the summary. Anna leaves.', { subheadings: false })),
    ).toEqual(['JUNK']);
    expect(codes(checkJunk('Конечно, вот пересказ. Анна уходит.', { subheadings: false }))).toEqual(
      ['JUNK'],
    );
    expect(checkJunk('Anna leaves the house. The rain goes on.', { subheadings: false })).toEqual(
      [],
    );
  });

  it('Markdown in a plain field is a remark; "## " subheadings pass only where allowed', () => {
    expect(codes(checkJunk('Anna **leaves** the house.', { subheadings: false }))).toEqual([
      'JUNK',
    ]);
    expect(codes(checkJunk('## Part one\n\nAnna leaves.', { subheadings: false }))).toEqual([
      'JUNK',
    ]);
    expect(checkJunk('Intro.\n\n## Part one\n\nAnna leaves.', { subheadings: true })).toEqual([]);
    expect(codes(checkJunk('Intro.\n- Anna leaves.\n- Bob stays.', { subheadings: true }))).toEqual(
      ['JUNK'],
    );
  });

  it('one subheading rule for structure and Markdown: a "## " line anywhere is its own block (F06 | F06-1, круг 3)', () => {
    const glued = 'Intro.\n## Part one\nAnna leaves.';
    expect(blocksOf(glued)).toEqual(['Intro.', '## Part one', 'Anna leaves.']);
    expect(checkJunk(glued, { subheadings: true })).toEqual([]);
    expect(codes(checkJunk(glued, { subheadings: false }))).toEqual(['JUNK']);
    expect(isSubheading('## Part one')).toBe(true);
    expect(isSubheading('##')).toBe(false);
    expect(isSubheading('## ')).toBe(false);
    expect(isSubheading('Text ## not a heading')).toBe(false);
  });

  it('isSubheading and blocksOf apply one subheading rule to every line shape (F06-2, хвост F06-1)', () => {
    const lines = [
      '## Part one',
      '##\tPart one',
      '##  Part',
      '##Part',
      '##',
      '## ',
      ' ## Part',
      '### Part',
    ];
    for (const line of lines) {
      const split = blocksOf(`Intro.\n${line}\nAnna leaves.`).includes(line);
      expect([line, isSubheading(line)]).toEqual([line, split]);
    }
  });

  it('a single dialogue line or numbered line is prose, not a Markdown list', () => {
    expect(checkJunk('- Hola, dice Ana.\n\nY se va.', { subheadings: false })).toEqual([]);
    expect(checkJunk('1. Anna leaves first.\n\nBob stays.', { subheadings: false })).toEqual([]);
    expect(checkJunk('- Привет.\n\n- Пока.', { subheadings: false })).toEqual([]);
    expect(checkJunk('1812. Война.\n\n1813. Мир.', { subheadings: false })).toEqual([]);
  });

  it('service phrases, addresses to the reader and spoiler warnings in all five languages', () => {
    const junk = [
      'Вот краткий пересказ. Анна уходит.',
      'В этой главе мы узнаем, что Анна уходит.',
      'Внимание, спойлер: Анна уходит.',
      'Aquí está el resumen. Ana se va.',
      'En este capítulo veremos que Ana se va.',
      '¡Alerta de spoiler! Ana se va.',
      'Voici le résumé. Anne part.',
      'Dans ce chapitre, nous voyons Anne partir.',
      'Attention, spoiler : Anne part.',
      'Aqui está o resumo. Ana parte.',
      'Neste capítulo vamos ver Ana partir.',
      'Aviso de spoiler: Ana parte.',
    ];
    for (const text of junk) {
      expect([text, codes(checkJunk(text, { subheadings: false }))]).toEqual([text, ['JUNK']]);
    }
  });

  it('every service phrase of the list is a remark (F06-2, хвост F06-1)', () => {
    expect(JUNK_PHRASES.length).toBeGreaterThan(0);
    for (const phrase of JUNK_PHRASES) {
      const text = `${phrase} Anna leaves the house.`;
      expect([phrase, codes(checkJunk(text, { subheadings: false }))]).toEqual([phrase, ['JUNK']]);
    }
  });

  it('a text broken off mid-sentence is a remark, also on a dash or a colon', () => {
    expect(codes(checkJunk('Anna leaves the house and', { subheadings: false }))).toEqual(['JUNK']);
    expect(codes(checkJunk('Anna turns and says —', { subheadings: false }))).toEqual(['JUNK']);
    expect(codes(checkJunk('Anna says:', { subheadings: false }))).toEqual(['JUNK']);
    expect(checkJunk('Anna says: «Goodbye.»', { subheadings: false })).toEqual([]);
  });
});

describe('LANGUAGE_MIXED', () => {
  const english =
    'Anna leaves the house in the morning and walks to the station with her old brother. ' +
    'They wait for the train for a long time and talk about the past and about the people ' +
    'they knew when they were young and when the house was still full of life.';
  const french =
    'Anna quitte la maison le matin et marche vers la gare avec son vieux frère. Ils attendent ' +
    'le train pendant longtemps et parlent du passé et des gens qu’ils ont connus quand ils ' +
    'étaient jeunes et quand la maison était encore pleine de vie.';

  it('a paragraph in another language than the version is a remark', () => {
    expect(codes(checkLanguage(`${english}\n\n${french}`, 'en', []))).toEqual(['LANGUAGE_MIXED']);
  });

  it('paragraphs in the language of the version are silent', () => {
    expect(checkLanguage(`${english}\n\n${english}`, 'en', [])).toEqual([]);
  });

  it('Russian, Spanish and Portuguese versions: own paragraphs are silent, an English one is a remark (F06-2, хвост F06-1)', () => {
    const own = {
      ru:
        'Анна выходит из дома рано утром и идёт на вокзал вместе со своим старым братом. Они долго ' +
        'ждут поезд и говорят о прошлом и о людях, которых знали, когда были молодыми и когда дом ' +
        'ещё был полон жизни, шума и детских голосов во всех комнатах.',
      es:
        'Ana sale de la casa por la mañana y camina hacia la estación con su viejo hermano. Esperan ' +
        'el tren durante mucho tiempo y hablan del pasado y de la gente que conocieron cuando eran ' +
        'jóvenes y cuando la casa todavía estaba llena de vida y de voces.',
      pt:
        'Ana sai de casa pela manhã e caminha até a estação com o seu velho irmão. Eles esperam o ' +
        'trem durante muito tempo e falam do passado e das pessoas que conheceram quando eram ' +
        'jovens e quando a casa ainda estava cheia de vida e de vozes.',
    } as const;
    for (const [language, text] of Object.entries(own) as Array<[keyof typeof own, string]>) {
      expect([language, checkLanguage(`${text}\n\n${text}`, language, [])]).toEqual([language, []]);
      expect([language, codes(checkLanguage(`${text}\n\n${english}`, language, []))]).toEqual([
        language,
        ['LANGUAGE_MIXED'],
      ]);
    }
  });

  it('a foreign paragraph shorter than the detector window is silent', () => {
    const short = french.split(' ').slice(0, 30).join(' ');
    expect(checkLanguage(`${english}\n\n${short}`, 'en', [])).toEqual([]);
  });

  it('glossary forms do not count as a foreign language', () => {
    // Все знаменательные слова абзаца - формы глоссария: после исключения абзац короче окна.
    const glossary = french
      .split(/[\s.’]+/)
      .filter((w) => w.length > 3)
      .map((w, i) => ({ key: `k${i}`, source: w, target: w }));
    expect(codes(checkLanguage(`${english}\n\n${french}`, 'en', []))).toEqual(['LANGUAGE_MIXED']);
    expect(checkLanguage(`${english}\n\n${french}`, 'en', glossary)).toEqual([]);
  });
});

describe('NAME_MISMATCH', () => {
  const glossary = [{ key: 'ivan', source: 'Ivan', target: 'Jean' }];

  it('the original form instead of the glossary form is a remark', () => {
    expect(codes(checkNames('Ivan goes home.', 'fr', glossary))).toEqual(['NAME_MISMATCH']);
  });

  it('the glossary form, a kept original and a name not in the text are silent', () => {
    expect(checkNames('Jean rentre chez lui.', 'fr', glossary)).toEqual([]);
    expect(checkNames('Ivan rentre.', 'fr', [{ ...glossary[0], keepOriginal: true }])).toEqual([]);
    expect(checkNames('Marie rentre.', 'fr', glossary)).toEqual([]);
  });

  it('the rule of the final check: a short name inside the target and a source that is another target are silent', () => {
    // «Rochester» - часть формы «señor Rochester»: короткое имя в пересказе - не второе написание.
    const titled = [{ key: 'r', source: 'Rochester', target: 'señor Rochester' }];
    expect(checkNames('Rochester sale de casa.', 'es', titled)).toEqual([]);
    // Форма оригинала одной записи - перевод другой (решение `F05 | F05-6`, 6c В7).
    const crossed = [
      { key: 'a', source: 'Jean', target: 'Juan' },
      { key: 'b', source: 'John', target: 'Jean' },
    ];
    expect(checkNames('Jean rentre.', 'fr', crossed)).toEqual([]);
  });
});

describe('wordCount', () => {
  it('counts words with inner apostrophes and hyphens as one', () => {
    expect(wordCount("Anna's well-known house, l’homme; 1905.")).toBe(5);
  });
});
