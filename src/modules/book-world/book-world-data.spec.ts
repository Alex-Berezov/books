import {
  WORLD_EDITOR_SUMMARY_SELECT,
  WORLD_SUMMARY_SELECT,
  mergeEntity,
  worldContentChanged,
  type StoredWorldEntity,
} from './book-world-data';

/**
 * F08-1, решение арбитра R9: импорт ставит `autoTextAt` только сущности, у которой после слияния
 * изменилось содержание. Сравнение — по хранимому виду, порядок ключей Json не в счёт (`jsonb`
 * его не хранит).
 */
const stored = (over: Partial<StoredWorldEntity> = {}): StoredWorldEntity => ({
  key: 'oblomov',
  type: 'character',
  name: 'Oblomov',
  role: 'main',
  aliases: ['Ilya'],
  short: 'Who he is.',
  sources: null,
  profile: { position: 'landowner', relationToMain: 'himself' },
  appearance: null,
  character: 'Kind.',
  arc: { from: 'a', to: 'b' },
  scenes: null,
  relations: null,
  quotes: [{ text: 'Q', chapter: 1, interpretation: 'I' }],
  critique: null,
  prototypes: null,
  adaptations: null,
  faq: null,
  ...over,
});

describe('worldContentChanged (F08-1, R9)', () => {
  it('новая сущность — изменение', () => {
    expect(worldContentChanged(null, stored())).toBe(true);
  });

  it('тело без полей — без изменений', () => {
    const before = stored();
    expect(
      worldContentChanged(before, mergeEntity(before, { key: 'oblomov', type: 'character' })),
    ).toBe(false);
  });

  it('то же значение — без изменений; другой порядок ключей Json — тоже', () => {
    const before = stored();
    const reordered = stored({ profile: { relationToMain: 'himself', position: 'landowner' } });
    expect(worldContentChanged(before, reordered)).toBe(false);
    expect(
      worldContentChanged(
        before,
        mergeEntity(before, { key: 'oblomov', type: 'character', short: ' Who he is. ' }),
      ),
    ).toBe(false);
  });

  it('изменилось любое содержательное поле — изменение', () => {
    const before = stored();
    for (const over of [
      { short: 'Other.' },
      { name: 'Ilya Oblomov' },
      { role: 'secondary' as const },
      { aliases: null },
      { quotes: [{ text: 'Q2', chapter: 1, interpretation: 'I' }] },
      { sources: [{ title: 'S', url: 'https://example.com' }] },
    ]) {
      expect({ over, changed: worldContentChanged(before, stored(over)) }).toEqual({
        over,
        changed: true,
      });
    }
  });
});

describe('выборки списка (F08-1)', () => {
  // Список не тянет тексты страниц: строка — поля сводки, у редактора ещё отметки (`LEGACY-127` класс).
  it('строка списка читателя и редактора — без Json-колонок', () => {
    expect(Object.keys(WORLD_SUMMARY_SELECT).sort()).toEqual(
      ['key', 'type', 'name', 'role', 'short', 'hasCore', 'isIndexable', 'updatedAt'].sort(),
    );
    expect(Object.keys(WORLD_EDITOR_SUMMARY_SELECT).sort()).toEqual(
      [
        ...Object.keys(WORLD_SUMMARY_SELECT),
        'isListed',
        'isVisible',
        'readAt',
        'autoTextAt',
        'firstPublishedAt',
        'coreMissing',
      ].sort(),
    );
  });
});
