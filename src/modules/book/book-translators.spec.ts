import { ContributorRole, Language } from '@prisma/client';
import {
  mapTranslators,
  translatorsSelect,
  TRANSLATORS_LIMIT,
  type TranslatorRow,
} from './book-translators';

const row = (canonicalName: string, localized?: string): TranslatorRow => ({
  person: {
    canonicalName,
    translations: localized === undefined ? [] : [{ displayName: localized }],
  },
});

describe('F01-5: mapTranslators', () => {
  it('отдаёт только имя: id, роль и заметки строки не копируются', () => {
    const extra = {
      ...row('Constance Garnett'),
      id: 'c1',
      role: 'TRANSLATOR',
      contributionNoteRu: 'секрет',
    };
    const [translator] = mapTranslators([extra]);
    expect(Object.keys(translator)).toEqual(['name']);
    expect(translator.name).toBe('Constance Garnett');
  });

  it('берёт перевод имени на языке запроса', () => {
    expect(mapTranslators([row('Constance Garnett', 'Констанс Гарнетт')])).toEqual([
      { name: 'Констанс Гарнетт' },
    ]);
  });

  it('без перевода имени откатывается на canonicalName', () => {
    expect(mapTranslators([row('Constance Garnett')])).toEqual([{ name: 'Constance Garnett' }]);
  });

  it('пустой displayName считается отсутствующим', () => {
    expect(mapTranslators([row('Constance Garnett', '  ')])).toEqual([
      { name: 'Constance Garnett' },
    ]);
  });

  it('сохраняет порядок выборки', () => {
    expect(mapTranslators([row('B'), row('A')])).toEqual([{ name: 'B' }, { name: 'A' }]);
  });

  it('одно имя дважды (связь не уникальна по персоне и роли) выводится один раз', () => {
    expect(mapTranslators([row('A'), row('B'), row('A', 'A')])).toEqual([
      { name: 'A' },
      { name: 'B' },
    ]);
  });

  it('пустое имя без перевода в ответ не уходит', () => {
    expect(mapTranslators([row('  '), row('B')])).toEqual([{ name: 'B' }]);
  });

  it('нет переводчиков - пустой массив, а не null', () => {
    expect(mapTranslators([])).toEqual([]);
  });
});

describe('F01-5: translatorsSelect', () => {
  const sel = translatorsSelect(Language.fr);

  it('только роль TRANSLATOR, не больше 10, порядок с тай-брейком', () => {
    expect(sel.where).toEqual({ role: ContributorRole.TRANSLATOR });
    expect(TRANSLATORS_LIMIT).toBe(10);
    expect(sel.take).toBe(10);
    expect(sel.orderBy).toEqual([{ displayOrder: 'asc' }, { id: 'asc' }]);
  });

  it('из контрибьютора выбрано только имя персоны, перевод - только на языке запроса', () => {
    expect(Object.keys(sel.select)).toEqual(['person']);
    expect(Object.keys(sel.select.person.select).sort()).toEqual(['canonicalName', 'translations']);
    expect(sel.select.person.select.translations).toEqual({
      where: { language: Language.fr },
      select: { displayName: true },
    });
  });
});
