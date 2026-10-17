import { plainToInstance } from 'class-transformer';
import { ValidationError, validateSync } from 'class-validator';
import { BOOK_ANALYSIS_LIMITS as L } from './book-analysis-blocks.dto';
import { UpdateBookAnalysisDto } from './update-book-analysis.dto';

/**
 * F03-1: лимиты импорта анализа на границе (решение арбитра А6) — ровно предел проходит, на один
 * больше — отказ с путём поля, как у боевого `ValidationPipe` (`whitelist` + `forbidNonWhitelisted`).
 */
const paths = (errors: ValidationError[], prefix = ''): string[] =>
  errors.flatMap((e) => {
    const path = prefix ? `${prefix}.${e.property}` : e.property;
    return e.children && e.children.length > 0 ? paths(e.children, path) : [path];
  });

const errorsOf = (body: Record<string, unknown>) =>
  paths(
    validateSync(plainToInstance(UpdateBookAnalysisDto, { language: 'en', ...body }), {
      whitelist: true,
      forbidNonWhitelisted: true,
    }),
  );

const times = <T>(n: number, make: (i: number) => T): T[] =>
  Array.from({ length: n }, (_, i) => make(i));

const LIST_CASES: [string, number, (i: number) => unknown][] = [
  ['themes', L.themes, (i) => ({ key: `t${i}`, title: 'T' })],
  ['characters', L.characters, (i) => ({ key: `h${i}`, name: 'N', role: 'main' })],
  ['keyQuotes', L.keyQuotes, (i) => ({ text: `q${i}` })],
  ['symbols', L.symbols, (i) => ({ title: `s${i}`, interpretation: 'i' })],
  ['timeline', L.timeline, () => ({ year: '1866', event: 'e', kind: 'book' })],
  ['style', L.style, () => ({ device: 'd', explanation: 'e' })],
  ['adaptations', L.adaptations, () => ({ title: 't', kind: 'film' })],
  ['misreadings', L.misreadings, () => ({ myth: 'm', explanation: 'e' })],
  ['discussionQuestions', L.discussionQuestions, (i) => `q${i}`],
  ['faq', L.faq, () => ({ question: 'q', answer: 'a' })],
  ['sources', L.sources, () => ({ title: 't', url: 'https://example.com' })],
];

describe('UpdateBookAnalysisDto: лимиты на границе (А6)', () => {
  // Числа — решение арбитра А6 и промпт `prompts/book-analysis.md`: правка константы без правки
  // решения и промпта краснеет здесь, а не уезжает молча.
  it('лимиты совпадают с решением А6', () => {
    expect(L).toMatchObject({
      themes: 8,
      characters: 20,
      keyQuotes: 12,
      relations: 6,
      symbols: 10,
      themeQuotes: 3,
      timeline: 20,
      style: 10,
      adaptations: 10,
      misreadings: 8,
      discussionQuestions: 12,
      faq: 10,
      sources: 15,
      mainIdea: 600,
      interpretation: 3000,
      quote: 500,
    });
  });

  it.each(LIST_CASES)('%s: %i проходит, на один больше — отказ', (key, max, make) => {
    expect(errorsOf({ [key]: times(max, make) })).toEqual([]);
    expect(errorsOf({ [key]: times(max + 1, make) })).toEqual([key]);
  });

  it('ключ: 60 знаков проходит, 61 и заглавные — отказ (А6)', () => {
    const t = (key: string) => [{ key, title: 'T' }];
    expect(errorsOf({ themes: t('a'.repeat(60)) })).toEqual([]);
    expect(errorsOf({ themes: t('a'.repeat(61)) })).toEqual(['themes.0.key']);
    expect(errorsOf({ themes: t('Guilt') })).toEqual(['themes.0.key']);
    expect(errorsOf({ themes: t('') })).toEqual(['themes.0.key']);
  });

  it('длины: главная мысль, толкование, цитата', () => {
    expect(errorsOf({ mainIdea: 'x'.repeat(L.mainIdea) })).toEqual([]);
    expect(errorsOf({ mainIdea: 'x'.repeat(L.mainIdea + 1) })).toEqual(['mainIdea']);
    const t = (interpretation: string) => [{ key: 'a', title: 'A', interpretation }];
    expect(errorsOf({ themes: t('x'.repeat(L.interpretation)) })).toEqual([]);
    expect(errorsOf({ themes: t('x'.repeat(L.interpretation + 1)) })).toEqual([
      'themes.0.interpretation',
    ]);
    expect(errorsOf({ keyQuotes: [{ text: 'x'.repeat(L.quote + 1) }] })).toEqual([
      'keyQuotes.0.text',
    ]);
  });

  it('главы: номер и число номеров у темы', () => {
    const t = (chapters: number[]) => [{ key: 'a', title: 'A', chapters }];
    expect(errorsOf({ themes: t([L.chapter]) })).toEqual([]);
    expect(errorsOf({ themes: t([L.chapter + 1]) })).toEqual(['themes.0.chapters']);
    expect(errorsOf({ themes: t(times(L.chapters, (i) => i + 1)) })).toEqual([]);
    expect(errorsOf({ themes: t(times(L.chapters + 1, (i) => i + 1)) })).toEqual([
      'themes.0.chapters',
    ]);
  });

  it('связи героя', () => {
    const rel = (n: number) => [
      { key: 'a', name: 'A', role: 'main', relations: times(n, () => ({ to: 'b', label: 'l' })) },
    ];
    expect(errorsOf({ characters: rel(L.relations) })).toEqual([]);
    expect(errorsOf({ characters: rel(L.relations + 1) })).toEqual(['characters.0.relations']);
  });

  it('год экранизации в границах', () => {
    const a = (year: number) => [{ title: 't', kind: 'film', year }];
    expect(errorsOf({ adaptations: a(L.adaptationYear.min) })).toEqual([]);
    expect(errorsOf({ adaptations: a(L.adaptationYear.max) })).toEqual([]);
    expect(errorsOf({ adaptations: a(L.adaptationYear.min - 1) })).toEqual(['adaptations.0.year']);
    expect(errorsOf({ adaptations: a(L.adaptationYear.max + 1) })).toEqual(['adaptations.0.year']);
  });
});
