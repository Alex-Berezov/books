import { checkAnalysisRefs, collectChapterRefs } from './book-analysis-refs';
import { EMPTY_BOOK_ANALYSIS, mergeAnalysis, type StoredBookAnalysis } from './book-analysis-data';
import type { UpdateBookAnalysisDto } from './dto/update-book-analysis.dto';

/** Перекрёстные ссылки на слитой записи и слияние T6 (`tech.md` §3). */
const base = (over: Partial<StoredBookAnalysis> = {}): StoredBookAnalysis => ({
  ...EMPTY_BOOK_ANALYSIS,
  themes: [{ key: 'guilt', title: 'Guilt' }],
  characters: [
    { key: 'rodion', name: 'Rodion', role: 'main', themeKeys: ['guilt'] },
    { key: 'sonya', name: 'Sonya', role: 'secondary' },
    { key: 'nastasya', name: 'Nastasya', role: 'minor' },
  ],
  ...over,
});

const dto = (over: Partial<UpdateBookAnalysisDto>): UpdateBookAnalysisDto =>
  ({ language: 'en', ...over }) as UpdateBookAnalysisDto;

describe('checkAnalysisRefs', () => {
  it('целая запись — без ошибок', () => {
    expect(checkAnalysisRefs(base())).toEqual([]);
  });

  it('неизвестный themeKeys — ошибка с путём ссылающегося поля', () => {
    const blocks = base({
      characters: [{ key: 'rodion', name: 'R', role: 'main', themeKeys: ['guilt', 'nope'] }],
    });
    expect(checkAnalysisRefs(blocks).map((e) => e.path)).toEqual(['characters.0.themeKeys.1']);
  });

  it('связь с эпизодическим, с собой и с несуществующим героем — отказ', () => {
    const blocks = base({
      characters: [
        {
          key: 'rodion',
          name: 'R',
          role: 'main',
          relations: [
            { to: 'sonya', label: 'loves' },
            { to: 'nastasya', label: 'servant' },
            { to: 'rodion', label: 'self' },
            { to: 'ghost', label: '?' },
          ],
        },
        { key: 'sonya', name: 'S', role: 'secondary' },
        { key: 'nastasya', name: 'N', role: 'minor' },
      ],
    });
    expect(checkAnalysisRefs(blocks).map((e) => e.path)).toEqual([
      'characters.0.relations.1.to',
      'characters.0.relations.2.to',
      'characters.0.relations.3.to',
    ]);
  });

  it('speakerKey и themeKeys цитаты проверяются', () => {
    const blocks = base({
      keyQuotes: [{ text: 'q', speakerKey: 'ghost', themeKeys: ['guilt', 'nope'] }],
    });
    expect(checkAnalysisRefs(blocks).map((e) => e.path)).toEqual([
      'keyQuotes.0.speakerKey',
      'keyQuotes.0.themeKeys.1',
    ]);
  });

  it('повтор ключа в списке — отказ по второму', () => {
    const blocks = base({
      themes: [
        { key: 'guilt', title: 'A' },
        { key: 'guilt', title: 'B' },
      ],
    });
    expect(checkAnalysisRefs(blocks).map((e) => e.path)).toEqual(['themes.1.key']);
  });
});

describe('mergeAnalysis + ссылки на слитой записи', () => {
  it('ключа нет — блок прежний; ссылка на тему из прошлого импорта проходит', () => {
    const merged = mergeAnalysis(
      base(),
      dto({ characters: [{ key: 'a', name: 'A', role: 'main', themeKeys: ['guilt'] }] }),
    );
    expect(merged.themes).toEqual(base().themes);
    expect(checkAnalysisRefs(merged)).toEqual([]);
  });

  it.each([[null], [[]]])(
    'очистка тем (%j) при живых themeKeys — ошибка по ссылающемуся полю',
    (cleared) => {
      const merged = mergeAnalysis(base(), dto({ themes: cleared as never }));
      expect(merged.themes).toBeNull();
      expect(checkAnalysisRefs(merged).map((e) => e.path)).toEqual(['characters.0.themeKeys.0']);
    },
  );

  it('пришедший список заменяет прежний целиком, пустая строка очищает текст', () => {
    const merged = mergeAnalysis(
      base({ mainIdea: 'old', symbols: [{ title: 'A', interpretation: 'a' }] }),
      dto({ symbols: [{ title: 'B', interpretation: 'b' }], mainIdea: '' }),
    );
    expect(merged.symbols).toEqual([{ title: 'B', interpretation: 'b' }]);
    expect(merged.mainIdea).toBeNull();
  });
});

describe('collectChapterRefs', () => {
  it('собирает номера глав всех блоков с путями', () => {
    const refs = collectChapterRefs({
      ...EMPTY_BOOK_ANALYSIS,
      themes: [{ key: 'g', title: 'G', chapters: [1, 2], quotes: [{ text: 'q', chapter: 3 }] }],
      characters: [{ key: 'r', name: 'R', role: 'main', quote: { text: 'q', chapter: 4 } }],
      symbols: [
        { title: 'S', interpretation: 's', chapters: [5], quote: { text: 'q', chapter: 6 } },
      ],
      keyQuotes: [{ text: 'q', chapter: 7 }],
      style: [{ device: 'd', explanation: 'e', example: { text: 'q', chapter: 8 } }],
    });
    expect(refs.map((r) => `${r.path}=${r.chapter}`)).toEqual([
      'themes.0.chapters.0=1',
      'themes.0.chapters.1=2',
      'themes.0.quotes.0.chapter=3',
      'characters.0.quote.chapter=4',
      'symbols.0.chapters.0=5',
      'symbols.0.quote.chapter=6',
      'keyQuotes.0.chapter=7',
      'style.0.example.chapter=8',
    ]);
  });
});
