import { computeAnalysisCore, isFilled } from './book-analysis-core';
import { EMPTY_BOOK_ANALYSIS, type StoredBookAnalysis } from './book-analysis-data';

/**
 * Ядро анализа (`product.md` §2, `tech.md` T7, решение арбитра А9): границы порогов и предикат
 * «заполнено» — текст после обрезки пробелов. Пустая строка не открывает страницу (урок `hasText`).
 */
const theme = (key: string, interpretation = 'Text.') => ({
  key,
  title: `T ${key}`,
  interpretation,
});
const hero = (key: string, description = 'Text.') => ({
  key,
  name: `N ${key}`,
  role: 'main' as const,
  description,
});
const quote = (text: string, interpretation = 'Text.') => ({ text, interpretation });

const full = (over: Partial<StoredBookAnalysis> = {}): StoredBookAnalysis => ({
  ...EMPTY_BOOK_ANALYSIS,
  mainIdea: 'Main idea.',
  themes: [theme('a'), theme('b')],
  characters: [hero('x'), hero('y')],
  keyQuotes: [quote('1'), quote('2'), quote('3')],
  ...over,
});

describe('computeAnalysisCore', () => {
  it('ровно на пороге: 2 темы, 2 героя, 3 цитаты и главная мысль — ядро есть', () => {
    expect(computeAnalysisCore(full())).toEqual({ hasCore: true, missing: [] });
  });

  it('1 тема — ядра нет, в недостающем «1 из 2»', () => {
    const res = computeAnalysisCore(full({ themes: [theme('a')] }));
    expect(res.hasCore).toBe(false);
    expect(res.missing).toEqual([{ part: 'themes', have: 1, need: 2 }]);
  });

  it('1 герой — ядра нет', () => {
    expect(computeAnalysisCore(full({ characters: [hero('x')] })).missing).toEqual([
      { part: 'characters', have: 1, need: 2 },
    ]);
  });

  it('2 цитаты — ядра нет, 3 — есть', () => {
    expect(computeAnalysisCore(full({ keyQuotes: [quote('1'), quote('2')] })).missing).toEqual([
      { part: 'keyQuotes', have: 2, need: 3 },
    ]);
    expect(computeAnalysisCore(full()).hasCore).toBe(true);
  });

  it.each([[''], ['   '], [' \n\t ']])('главная мысль %j не заполнена', (mainIdea) => {
    expect(computeAnalysisCore(full({ mainIdea })).missing).toEqual([
      { part: 'mainIdea', have: 0, need: 1 },
    ]);
  });

  it('толкование из пробелов не считается: тема, герой и цитата выпадают из счёта', () => {
    const res = computeAnalysisCore(
      full({
        themes: [theme('a'), theme('b', '  \n\n ')],
        characters: [hero('x'), hero('y', ' ')],
        keyQuotes: [quote('1'), quote('2'), quote('3', '\t')],
      }),
    );
    expect(res.hasCore).toBe(false);
    expect(res.missing.map((m) => m.part)).toEqual(['themes', 'characters', 'keyQuotes']);
  });

  it('название темы, имя героя и текст цитаты из пробелов тоже не считаются (А9)', () => {
    const res = computeAnalysisCore(
      full({
        themes: [theme('a'), { key: 'b', title: ' ', interpretation: 'Text.' }],
        characters: [hero('x'), { key: 'y', name: '', role: 'main', description: 'Text.' }],
        keyQuotes: [quote('1'), quote('2'), quote('  ')],
      }),
    );
    expect(res.missing.map((m) => m.part)).toEqual(['themes', 'characters', 'keyQuotes']);
  });

  it('пустая запись — недостаёт всех четырёх частей', () => {
    expect(computeAnalysisCore(EMPTY_BOOK_ANALYSIS).missing.map((m) => m.part)).toEqual([
      'mainIdea',
      'themes',
      'characters',
      'keyQuotes',
    ]);
  });
});

describe('isFilled', () => {
  it('текст после обрезки', () => {
    expect(isFilled('a')).toBe(true);
    expect(isFilled('  a ')).toBe(true);
    expect(isFilled('')).toBe(false);
    expect(isFilled('   ')).toBe(false);
    expect(isFilled(null)).toBe(false);
    expect(isFilled(undefined)).toBe(false);
  });
});
