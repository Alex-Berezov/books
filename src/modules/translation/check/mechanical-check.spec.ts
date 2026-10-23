import { corpusChunks, parallelChapters } from '../../../common/testing/language-corpus';
import { sentencesOf } from './language-detector';
import { lengthCorridor, textLength } from './length-corridors';
import {
  checkMechanical,
  FOREIGN_SHARE_MAX,
  formFound,
  MechanicalInput,
  normalized,
} from './mechanical-check';

/** Строки главы - в `count` блоков подряд: у параллельных глав число строк разное. */
function grouped(text: string, count: number): string[] {
  const lines = text.split('\n');
  return Array.from({ length: count }, (_, i) =>
    lines
      .slice(Math.floor((i * lines.length) / count), Math.floor(((i + 1) * lines.length) / count))
      .join(' '),
  );
}

/** Испанский «перевод» английского исходника: исходник и перевод - параллельные главы корпуса. */
function input(overrides: Partial<MechanicalInput> = {}): MechanicalInput {
  const [en, es] = [parallelChapters('en')[0], parallelChapters('es')[0]];
  const count = Math.min(en.split('\n').length, es.split('\n').length);
  const source = grouped(en, count).map((p, i) => ({ n: i + 1, html: `<p>${p}</p>` }));
  const translated = grouped(es, count).map((text, i) => ({ n: i + 1, text }));
  return {
    sourceLanguage: 'en',
    targetLanguage: 'es',
    source,
    translated,
    glossary: [],
    ...overrides,
  };
}

const codes = (i: MechanicalInput) => checkMechanical(i).failures.map((f) => f.code);

describe('checkMechanical', () => {
  it('a faithful translation passes', () => {
    const result = checkMechanical(input());
    expect(result.failures).toEqual([]);
    expect(result.language).toBe('es');
  });

  it('a Portuguese piece in a Spanish translation fails by language (product.md §7 п.3)', () => {
    const base = input();
    const pt = sentencesOf(corpusChunks('pt')[0]);
    const translated = base.translated.map((b, i) => ({ n: b.n, text: pt[i] ?? pt[0] }));
    expect(codes({ ...base, translated })).toContain('LANGUAGE_MISMATCH');
  });

  it('a third of the blocks left in Portuguese fails by the foreign share', () => {
    const base = input();
    // Каждый третий блок - португальский той же длины в словах: около трети текста.
    const pt = corpusChunks('pt')[1].split(/\s+/);
    let at = 0;
    const translated = base.translated.map((b, i) => {
      if (i % 3 !== 0) return b;
      const size = b.text.split(/\s+/).length;
      at += size;
      return { n: b.n, text: `${pt.slice(at - size, at).join(' ')}.` };
    });
    // Язык куска в целом - испанский: ловит именно доля, а не язык куска.
    const result = checkMechanical({ ...base, translated });
    expect(result.language).toBe('es');
    expect(result.failures.map((f) => f.code)).toContain('FOREIGN_SHARE');
  });

  it('one Portuguese paragraph of 40 words and more among Spanish ones fails as a foreign block (§3 п.1)', () => {
    const base = input();
    const pt = sentencesOf(corpusChunks('pt')[2]).join(' ').split(' ').slice(0, 60).join(' ') + '.';
    const translated = base.translated.map((b, i) => (i === 1 ? { n: b.n, text: pt } : b));
    const result = checkMechanical({ ...base, translated });
    expect(result.foreignShare).toBeLessThan(FOREIGN_SHARE_MAX);
    expect(result.failures.map((f) => f.code)).toEqual(['FOREIGN_BLOCK']);
    expect(result.failures[0].remark).toContain('Blocks 2 are not in Spanish');
  });

  it('the clean corpus gives no foreign block, except the French lines Tolstoy wrote into Hadji Murat', () => {
    const hits: string[] = [];
    for (const language of ['en', 'es', 'fr', 'pt', 'ru'] as const) {
      corpusChunks(language).forEach((chunk, i) => {
        const blocks = chunk.split('\n').map((p, n) => ({ n: n + 1, html: `<p>${p}</p>` }));
        const result = checkMechanical({
          sourceLanguage: language,
          targetLanguage: language,
          source: blocks,
          translated: blocks.map((b) => ({ n: b.n, text: b.html })),
          glossary: [],
        });
        if (result.failures.some((f) => f.code === 'FOREIGN_BLOCK')) hits.push(`${language}#${i}`);
      });
    }
    // Замер 23.10.2026 (дело F05-5): 2 абзаца из 1885 от 40 слов - настоящий французский у Толстого.
    expect(hits).toHaveLength(2);
    expect(hits.every((h) => h.startsWith('ru#'))).toBe(true);
  });

  it('the source left untranslated fails: source words are not an exception', () => {
    const base = input();
    const translated = base.source.map((b) => ({ n: b.n, text: b.html }));
    expect(codes({ ...base, translated })).toContain('LANGUAGE_MISMATCH');
  });

  it('a glossary form kept in the original is not a foreign language', () => {
    const base = input({ targetLanguage: 'en', sourceLanguage: 'es' });
    const source = base.translated.map((b) => ({ n: b.n, html: `<p>${b.text}</p>` }));
    const name = 'Fray Bartolomé de las Casas y Nuestra Señora del Pilar de Zaragoza';
    const translated = base.source.map((b) => ({
      n: b.n,
      text: `${b.html.replace(/<\/?p>/g, '')} ${name}.`,
    }));
    const glossary = [{ key: 'fray', source: name, target: name, keepOriginal: true }];
    expect(codes({ ...base, source, translated, glossary })).not.toContain('FOREIGN_SHARE');
  });

  it('function words of a glossary form are not excluded: a clean Spanish piece stays Spanish', () => {
    const base = input();
    const glossary = [
      { key: 'viejo', source: 'Old Man of the Mountain', target: 'el Viejo de la Montaña' },
      { key: 'maga', source: 'the Witch', target: 'la Maga' },
    ];
    const result = checkMechanical({ ...base, glossary });
    expect(result.language).toBe('es');
    expect(result.failures).toEqual([]);
    // Кусок, где признаки языка - почти одни служебные слова формы: исключи их - язык не определится.
    const thin = checkMechanical({
      sourceLanguage: 'en',
      targetLanguage: 'es',
      source: [{ n: 1, html: '<p>It was so and the son of the man.</p>' }],
      translated: [{ n: 1, text: 'Era así, y el hijo de la que no se fue con los del pueblo.' }],
      glossary: [{ key: 'k', source: 'K', target: 'el de la que y no se con los del' }],
    });
    expect(thin.language).toBe('es');
  });

  it('a dropped block fails by block numbers, an emptied one by an empty block (§7 п.4)', () => {
    const base = input();
    expect(codes({ ...base, translated: base.translated.slice(1) })).toContain('BLOCKS_MISMATCH');
    const emptied = base.translated.map((b, i) => (i === 2 ? { n: b.n, text: '' } : b));
    expect(codes({ ...base, translated: emptied })).toContain('BLOCK_EMPTY');
  });

  it('a translation twice as long fails by the upper bound of the corridor', () => {
    const base = input();
    const translated = base.translated.map((b) => ({ n: b.n, text: `${b.text} ${b.text}` }));
    const result = checkMechanical({ ...base, translated });
    expect(result.failures.map((f) => f.code)).toEqual(['LENGTH_OUT_OF_RANGE']);
    expect(result.failures[0].remark).toContain('much longer');
  });

  it('a source shorter than 500 characters is not checked by length', () => {
    const source = [{ n: 1, html: '<p>John came home and he was tired.</p>' }];
    const result = checkMechanical({
      ...input(),
      source,
      translated: [
        { n: 1, text: 'Juan llegó a casa, y estaba muy cansado después de un largo día de viaje.' },
      ],
    });
    expect(result.lengthRatio).toBeGreaterThan(1.4);
    expect(result.failures).toEqual([]);
  });

  it('half of the text left out fails by the length corridor', () => {
    const base = input();
    const translated = base.translated.map((b) => ({
      n: b.n,
      text: b.text.slice(0, b.text.length / 3) + '.',
    }));
    expect(codes({ ...base, translated })).toContain('LENGTH_OUT_OF_RANGE');
  });

  it('the measured parallel chapters sit inside the corridor of every pair', () => {
    const languages = ['en', 'es', 'fr', 'pt', 'ru'] as const;
    for (const from of languages) {
      for (const to of languages) {
        const corridor = lengthCorridor(from, to);
        if (!corridor) continue;
        parallelChapters(from).forEach((chapter, i) => {
          const ratio = textLength(parallelChapters(to)[i]) / textLength(chapter);
          expect(ratio).toBeGreaterThanOrEqual(corridor[0]);
          expect(ratio).toBeLessThanOrEqual(corridor[1]);
        });
      }
    }
  });

  it('a service phrase of the model fails; the same phrase in the source does not', () => {
    const base = input();
    const translated = base.translated.map((b, i) =>
      i === 0 ? { n: b.n, text: `Aquí está la traducción: ${b.text}` } : b,
    );
    expect(codes({ ...base, translated })).toContain('SERVICE_PHRASE');
    const source = base.source.map((b, i) =>
      i === 0 ? { n: b.n, html: `<p>Aquí está la traducción. ${b.html}</p>` } : b,
    );
    expect(codes({ ...base, source, translated })).not.toContain('SERVICE_PHRASE');
  });

  it('a service phrase is matched as whole words: "as an aide" and "вот переводчик" are text', () => {
    const base = input();
    const translated = base.translated.map((b, i) =>
      i === 0 ? { n: b.n, text: `Ella sirvió as an aide del duque. ${b.text}` } : b,
    );
    expect(codes({ ...base, translated })).not.toContain('SERVICE_PHRASE');
    // Типографский апостроф - та же фраза.
    const curly = base.translated.map((b, i) =>
      i === 0 ? { n: b.n, text: `Here’s the translation: ${b.text}` } : b,
    );
    expect(codes({ ...base, translated: curly })).toContain('SERVICE_PHRASE');
  });

  it("the author's translator's note in the source in another language is not a service phrase of the model", () => {
    const base = input({ sourceLanguage: 'ru', targetLanguage: 'en' });
    const source = [{ n: 1, html: '<p>Примечание переводчика. Он ушёл домой и закрыл дверь.</p>' }];
    const translated = [{ n: 1, text: "Translator's note. He went home and shut the door." }];
    expect(codes({ ...base, source, translated, glossary: [] })).not.toContain('SERVICE_PHRASE');
    const own = [{ n: 1, html: '<p>Он ушёл домой и закрыл дверь.</p>' }];
    expect(codes({ ...base, source: own, translated, glossary: [] })).toContain('SERVICE_PHRASE');
  });

  it('a closing typographic quote ends the sentence: Russian „…“ is not truncated', () => {
    const base = input({ sourceLanguage: 'en', targetLanguage: 'ru' });
    const source = [{ n: 1, html: '<p>He said: "Go home."</p>' }];
    const translated = [{ n: 1, text: 'Он сказал: „Иди домой.“' }];
    expect(codes({ ...base, source, translated, glossary: [] })).not.toContain('TRUNCATED');
  });

  it('a translation broken off mid-sentence fails as truncated', () => {
    const base = input();
    const last = base.translated.length - 1;
    const translated = base.translated.map((b, i) =>
      i === last ? { n: b.n, text: b.text.replace(/[.!?…»"”'’)]+\s*$/u, '') + ' y entonces' } : b,
    );
    expect(codes({ ...base, translated })).toContain('TRUNCATED');
  });

  it('a name in another grammatical form is found by its stem; a missing one is a mark, not a failure', () => {
    const words = (t: string) => normalized(t).match(/\p{L}+/gu) ?? [];
    // Склоняет имена только русский: основа с падежным окончанием.
    expect(formFound('Джон', words('Он увидел Джона у ворот.'), 'ru')).toBe(true);
    expect(formFound('Мария', words('Он позвал Марию.'), 'ru')).toBe(true);
    expect(formFound('Анна', words('Он говорил с Анной.'), 'ru')).toBe(true);
    expect(formFound('Борис', words('Ждали Бориса.'), 'ru')).toBe(true);
    expect(formFound('Джон', words('Он увидел Джека у ворот.'), 'ru')).toBe(false);
    expect(formFound('Мария', words('Это было в марте.'), 'ru')).toBe(false);
    expect(formFound('Борис', words('Шёл на бора.'), 'ru')).toBe(false);
    expect(formFound('Леон', words('Леонардо ушёл.'), 'ru')).toBe(false);
    // Остальные языки имён не склоняют: имя - целым словом, а не началом другого слова.
    expect(formFound('el Quijote', words('la historia del Quijote'), 'es')).toBe(true);
    expect(formFound('Mark', words("Mark's hat."), 'en')).toBe(true);
    expect(formFound('Mark', words('He went to the market.'), 'en')).toBe(false);
    expect(formFound('Paris', words('Fue para la ciudad.'), 'es')).toBe(false);
    expect(formFound('Clara', words('Está claro.'), 'es')).toBe(false);
    expect(formFound('Sol', words('Vino solo a casa.'), 'es')).toBe(false);
    expect(formFound('Ana', words('Quiso analizar todo.'), 'es')).toBe(false);
    expect(formFound('Li', words('I like little things.'), 'en')).toBe(false);
    expect(formFound('Li', words('Li came.'), 'en')).toBe(true);
    // Многословное имя - целиком: артикли не мешают, одно нарицательное слово не находит его.
    expect(
      formFound('Fray Bartolomé de las Casas', words('Habló Fray Bartolomé de las Casas.'), 'es'),
    ).toBe(true);
    expect(formFound('Fray Bartolomé de las Casas', words('Vio las casas del pueblo.'), 'es')).toBe(
      false,
    );

    const base = input();
    const source = [{ n: 1, html: '<p>John saw the house of his father and he went in.</p>' }];
    const glossary = [{ key: 'john', source: 'John', target: 'Juan' }];
    const found = checkMechanical({
      ...base,
      source,
      translated: [{ n: 1, text: 'Juan vio la casa de su padre y entró en ella.' }],
      glossary,
    });
    expect(found.nameMisses).toEqual([]);
    const missed = checkMechanical({
      ...base,
      source,
      translated: [{ n: 1, text: 'Él vio la casa de su padre y entró en ella.' }],
      glossary,
    });
    expect(missed.nameMisses).toEqual(['john']);
    expect(missed.failures).toEqual([]);
  });
});
