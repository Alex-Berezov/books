import type { StoredWorldEntity } from './book-world-data';
import { checkWorldRefs, duplicateWorldKeys, worldEntityRefs } from './world-refs';

/** F08-1: ссылки на слитой сущности (`tech.md` §3, решение арбитра `F08 | F08-1` R7). */
const entity = (over: Partial<StoredWorldEntity> = {}): StoredWorldEntity => ({
  key: 'oblomov',
  type: 'character',
  name: 'Oblomov',
  role: 'main',
  aliases: null,
  sources: null,
  short: null,
  profile: null,
  appearance: null,
  character: null,
  arc: null,
  scenes: null,
  relations: null,
  quotes: null,
  critique: null,
  prototypes: null,
  adaptations: null,
  faq: null,
  ...over,
});
const ctx = (entityKeys: string[], analysisKeys: string[] = []) => ({
  entityKeys: new Set(entityKeys),
  analysisKeys: new Set(analysisKeys),
});
const quote = (speakerKey?: string) => ({
  text: 'Q',
  chapter: 1,
  interpretation: 'I',
  ...(speakerKey ? { speakerKey } : {}),
});

describe('checkWorldRefs (F08-1)', () => {
  it('неизвестный relations.0.to — ошибка с путём', () => {
    const e = entity({ relations: [{ to: 'nobody', label: 'friend' }] });
    expect(checkWorldRefs(e, ctx(['oblomov']))).toEqual([
      { path: 'relations.0.to', message: 'unknown entity or character key "nobody"' },
    ]);
  });

  it('неизвестный speakerKey — ошибка с путём', () => {
    const e = entity({ quotes: [quote('oblomov'), quote('ghost')] });
    expect(checkWorldRefs(e, ctx(['oblomov'])).map((r) => r.path)).toEqual(['quotes.1.speakerKey']);
  });

  it('связь с собой — ошибка', () => {
    const e = entity({ relations: [{ to: 'oblomov', label: 'self' }] });
    expect(checkWorldRefs(e, ctx(['oblomov']))).toEqual([
      { path: 'relations.0.to', message: 'an entity cannot relate to itself' },
    ]);
  });

  it('ключ героя анализа без сущности мира проходит (R7)', () => {
    const e = entity({
      relations: [{ to: 'olga', label: 'loves' }],
      quotes: [quote('stolz')],
    });
    expect(checkWorldRefs(e, ctx(['oblomov'], ['olga', 'stolz']))).toEqual([]);
  });

  it('ключ другой сущности версии проходит', () => {
    const e = entity({ relations: [{ to: 'zakhar', label: 'servant' }] });
    expect(checkWorldRefs(e, ctx(['oblomov', 'zakhar']))).toEqual([]);
  });

  it('critique, prototypes, adaptations без sources — ошибки; с sources — нет', () => {
    const external = {
      critique: 'C',
      prototypes: 'P',
      adaptations: [{ title: 'Film', differences: 'D' }],
    };
    expect(checkWorldRefs(entity(external), ctx(['oblomov'])).map((r) => r.path)).toEqual([
      'critique',
      'prototypes',
      'adaptations',
    ]);
    const withSources = entity({
      ...external,
      sources: [{ title: 'S', url: 'https://example.com' }],
    });
    expect(checkWorldRefs(withSources, ctx(['oblomov']))).toEqual([]);
  });
});

describe('worldEntityRefs (F08-1)', () => {
  // Один перечень полей-ссылок на проверку ссылок и на отказ удаления `WORLD_ENTITY_REFERENCED`.
  it('relations[].to и quotes[].speakerKey с путями; цитата без говорящего — не ссылка', () => {
    const e = entity({
      relations: [{ to: 'zakhar', label: 'servant' }],
      quotes: [quote(), quote('olga')],
    });
    expect(worldEntityRefs(e)).toEqual([
      { kind: 'relation', path: 'relations.0.to', key: 'zakhar' },
      { kind: 'speaker', path: 'quotes.1.speakerKey', key: 'olga' },
    ]);
  });
});

describe('duplicateWorldKeys (F08-1)', () => {
  it('дубль ключа в теле — путь второго', () => {
    expect(duplicateWorldKeys([{ key: 'a' }, { key: 'b' }, { key: 'a' }])).toEqual([
      { path: 'entities.2.key', message: 'duplicate key "a"' },
    ]);
  });
});
