import type { StoredWorldEntity } from './book-world-data';
import {
  characterKeyRefused,
  checkCharacterKey,
  checkWorldPair,
  checkWorldRefs,
  checkWorldTypeFields,
  duplicateWorldKeys,
  entitiesReferring,
  pairEvidenceOf,
  missingPairMembers,
  pairFounded,
  pairKeyTaken,
  savedMentionsOf,
  worldPairKey,
  pairMembers,
  pairsHolding,
  worldEntityRefs,
  type WorldPairEvidence,
} from './world-refs';

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
  compare: null,
  bonds: null,
  differences: null,
  conclusion: null,
  kind: null,
  location: null,
  significance: null,
  description: null,
  wikidataId: null,
  imageBrief: null,
  imageBriefFor: null,
  faq: null,
  ...over,
});
const ctx = (entityKeys: string[], analysisKeys: string[] = []) => ({
  entityKeys: new Set(entityKeys),
  analysisKeys: new Set(analysisKeys),
  characterKeys: new Set(entityKeys),
});
const quote = (speakerKey?: string) => ({
  text: 'Q',
  chapter: 1,
  interpretation: 'I',
  ...(speakerKey ? { speakerKey } : {}),
});

describe('checkWorldRefs (F08-1)', () => {
  it('пара: checkWorldRefs молчит — одна ошибка на поле даёт checkWorldTypeFields (F08-8c)', () => {
    const p = entity({
      key: 'a--b',
      type: 'pair',
      role: null,
      relations: [{ to: 'nobody', label: 'x' }],
      critique: 'C',
      prototypes: 'P',
      adaptations: [{ title: 'T', year: null, actor: null, differences: 'D' }],
    });
    expect(checkWorldRefs(p, ctx(['a', 'b']))).toEqual([]);
    const fields = checkWorldTypeFields(p, { aliasExclusions: null, aliasChapterExclusions: null });
    for (const f of ['relations', 'critique', 'prototypes', 'adaptations']) {
      expect(fields.filter((e) => e.path === f)).toHaveLength(1);
    }
  });

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

describe('pairsHolding (F08-8c-2: одно условие «герой в составе пары» для удаления и смены типа)', () => {
  it('держат героя только пары с ним в ключе; ссылки из блоков героев не в счёт', () => {
    const others = [
      { key: 'oblomov--olga', type: 'pair' },
      { key: 'olga--zakhar', type: 'pair' },
      { key: 'oblomov--zakhar', type: 'pair' },
      // Герой с ключом вида пары не держит: только тип `pair` даёт ссылку `member`.
      { key: 'olga--stolz', type: 'character' },
      { key: 'stolz', type: 'character' },
    ] as Pick<StoredWorldEntity, 'key' | 'type'>[];
    expect(pairsHolding('olga', others)).toEqual(['oblomov--olga', 'olga--zakhar']);
    expect(pairsHolding('stolz', others)).toEqual([]);
  });
});

describe('duplicateWorldKeys (F08-1)', () => {
  it('дубль ключа в теле — путь второго', () => {
    expect(duplicateWorldKeys([{ key: 'a' }, { key: 'b' }, { key: 'a' }])).toEqual([
      { path: 'entities.2.key', message: 'duplicate key "a"' },
    ]);
  });
});

describe('пара героев (F08-8c, решения арбитра `F08 | F08-8c` Q1, Q2, Q4)', () => {
  const evidence =
    (e: Partial<WorldPairEvidence> = {}) =>
    (): WorldPairEvidence => ({
      isLinked: true,
      chaptersA: null,
      chaptersB: null,
      common: 0,
      ...e,
    });
  const pair = (key: string, over: Partial<StoredWorldEntity> = {}) =>
    entity({ key, type: 'pair', role: null, name: 'A and B', ...over });
  const heroes = ctx(['anna', 'tom', 'anna--tom']);
  const keyErrors = (key: string) =>
    checkWorldPair(pair(key), heroes, evidence()).map((e) => `${e.path}: ${e.message}`);

  describe('pairFounded — граница трети без округления', () => {
    // 3·общие ≥ глав каждого: 3 главы и 1 общая — ровно треть.
    it('ровно треть глав каждого — заводится', () => {
      expect(pairFounded({ isLinked: false, chaptersA: 3, chaptersB: 3, common: 1 })).toBe(true);
    });
    it('на одну главу больше трети у одного из героев — нет', () => {
      expect(pairFounded({ isLinked: false, chaptersA: 4, chaptersB: 3, common: 1 })).toBe(false);
      expect(pairFounded({ isLinked: false, chaptersA: 3, chaptersB: 4, common: 1 })).toBe(false);
    });
    it('общих глав нет — нет, даже у героев без глав', () => {
      expect(pairFounded({ isLinked: false, chaptersA: 0, chaptersB: 0, common: 0 })).toBe(false);
    });
    it('присутствие не посчитано — нет; связь в анализе — да без присутствия', () => {
      expect(pairFounded({ isLinked: false, chaptersA: null, chaptersB: 3, common: 3 })).toBe(
        false,
      );
      expect(pairFounded({ isLinked: true, chaptersA: null, chaptersB: null, common: 0 })).toBe(
        true,
      );
    });
  });

  it('ключ по алфавиту из двух героев версии — без ошибок', () => {
    expect(keyErrors('anna--tom')).toEqual([]);
  });

  it('ключ не по алфавиту, один и тот же герой, не герой версии, не одно «--» — отказ путём key', () => {
    expect(keyErrors('tom--anna')).toEqual([
      'key: pair keys go in alphabetical order: "anna--tom"',
    ]);
    expect(keyErrors('anna--anna')).toEqual(['key: a pair needs two different characters']);
    expect(keyErrors('anna--stolz')).toEqual(['key: "stolz" is not a character of this version']);
    for (const key of ['anna---tom', 'anna--tom--x', 'anna-tom', '--tom', 'anna--']) {
      expect(keyErrors(key)).toEqual([
        'key: a pair key is {a}--{b}: two character keys joined by one "--"',
      ]);
    }
    // Длиннее предела ключа (60) — отказ, хотя оба героя есть (решение арбитра Q1).
    const longKey = `${'a'.repeat(30)}--${'b'.repeat(30)}`;
    expect(
      checkWorldPair(pair(longKey), ctx(['a'.repeat(30), 'b'.repeat(30)]), evidence()).map(
        (e) => e.path,
      ),
    ).toEqual(['key']);
  });

  it('условие заведения не выполнено — отказ путём key; выполнено — пусто', () => {
    expect(
      checkWorldPair(pair('anna--tom'), heroes, evidence({ isLinked: false })).map((e) => e.path),
    ).toEqual(['key']);
    expect(
      checkWorldPair(
        pair('anna--tom'),
        heroes,
        evidence({ isLinked: false, chaptersA: 3, chaptersB: 3, common: 1 }),
      ),
    ).toEqual([]);
  });

  it('цитата пары: говорящий и о ком — только герои пары и не один и тот же', () => {
    const q = (speakerKey: string | null, aboutKey: string | null) => ({
      ...quote(),
      speakerKey,
      aboutKey,
    });
    expect(
      checkWorldPair(
        pair('anna--tom', {
          quotes: [q('anna', 'tom'), q('olga', 'anna'), q('tom', 'tom'), q(null, null)],
        }),
        heroes,
        evidence(),
      ),
    ).toEqual([
      { path: 'quotes.1.speakerKey', message: '"olga" is not a character of this pair' },
      { path: 'quotes.2.aboutKey', message: 'a quote of a pair is about the other character' },
      // «Друг о друге» (`product.md` §6): о ком — обязательно, рассказчик без адресата — отказ.
      {
        path: 'quotes.3.speakerKey',
        message: 'a quote of a pair is said by one of its characters',
      },
      { path: 'quotes.3.aboutKey', message: 'a quote of a pair names the character it is about' },
    ]);
    expect(
      checkWorldPair(pair('anna--tom', { quotes: [q(null, 'tom')] }), heroes, evidence()),
    ).toEqual([
      // Рассказчик об одном из героев — не «друг о друге» (`product.md` §6, ревью круга 2).
      {
        path: 'quotes.0.speakerKey',
        message: 'a quote of a pair is said by one of its characters',
      },
    ]);
    expect(
      checkWorldPair(pair('anna--tom', { quotes: [q('anna', 'tom')] }), heroes, evidence()),
    ).toEqual([]);
    // Ссылки цитат пары не проверяются второй раз общим правилом (ключи анализа ей не годятся).
    expect(checkWorldRefs(pair('anna--tom', { quotes: [q('olga', null)] }), heroes)).toEqual([]);
  });

  it('поля не своего типа: у пары — героя, роль и формы; у героя — пары и aboutKey', () => {
    const none = { aliasExclusions: null, aliasChapterExclusions: null };
    expect(
      checkWorldTypeFields(
        pair('anna--tom', { role: 'main', aliases: ['A'], character: 'x', scenes: [] }),
        { aliasExclusions: ['A'], aliasChapterExclusions: null },
      ).map((e) => e.path),
    ).toEqual(['character', 'scenes', 'role', 'aliases', 'aliasExclusions']);
    // Источников у пары нет: внешних блоков у страницы пары нет (`product.md` §6, Q2).
    expect(
      checkWorldTypeFields(
        pair('anna--tom', { sources: [{ title: 'S', url: 'https://x.io' }] }),
        none,
      ),
    ).toEqual([{ path: 'sources', message: 'sources is not a field of a pair' }]);
    expect(
      checkWorldTypeFields(
        entity({ conclusion: 'x', quotes: [{ ...quote(), aboutKey: 'tom' }] }),
        none,
      ),
    ).toEqual([
      { path: 'conclusion', message: 'conclusion is not a field of a character' },
      { path: 'quotes.0.aboutKey', message: 'quotes.0.aboutKey is not a field of a character' },
    ]);
    expect(checkWorldTypeFields(pair('anna--tom'), none)).toEqual([]);
  });

  // F08-11d-2, решение `F08 | F08-11d-2` (импорт): ТЗ — поле героя любой роли; у пары и места — отказ.
  it('imageBrief: поле героя (любой роли, с «Внешностью» и без); у пары и места — не своё', () => {
    const none = { aliasExclusions: null, aliasChapterExclusions: null };
    const brief = { imageBrief: 'Square 1:1 portrait.' };
    expect(checkWorldTypeFields(entity(brief), none)).toEqual([]);
    expect(checkWorldTypeFields(entity({ ...brief, role: 'minor' }), none)).toEqual([]);
    expect(checkWorldTypeFields(pair('anna--tom', brief), none)).toEqual([
      { path: 'imageBrief', message: 'imageBrief is not a field of a pair' },
    ]);
    expect(
      checkWorldTypeFields(entity({ ...brief, type: 'place', role: null }), none).map(
        (e) => e.path,
      ),
    ).toEqual(['imageBrief']);
    // Отпечаток идёт за ТЗ и в теле не задаётся: смена типа называет только ТЗ.
    expect(
      checkWorldTypeFields(pair('anna--tom', { ...brief, imageBriefFor: 'p' }), none).map(
        (e) => e.path,
      ),
    ).toEqual(['imageBrief']);
  });

  it('worldEntityRefs: герои ключа пары — ссылки (героя из-под пары не удалить), aboutKey — тоже', () => {
    expect(
      worldEntityRefs(pair('anna--tom', { quotes: [{ ...quote(), aboutKey: 'tom' }] })),
    ).toEqual([
      { kind: 'member', path: 'key', key: 'anna' },
      { kind: 'member', path: 'key', key: 'tom' },
      { kind: 'about', path: 'quotes.0.aboutKey', key: 'tom' },
    ]);
    // У героя ключ с «--» членов не даёт.
    expect(worldEntityRefs(entity({ key: 'anna--tom' }))).toEqual([]);
  });
});

describe('пара героев: заведённая пара и ссылки героя (F08-8c-1, решение арбитра R1, ревью круга 1)', () => {
  const pair = (key: string, over: Partial<StoredWorldEntity> = {}) =>
    entity({ key, type: 'pair', role: null, name: 'A and B', ...over });
  const notFounded = () => ({ isLinked: false, chaptersA: 9, chaptersB: 9, common: 1 });

  it('evidence = null (пара уже заведена) — условие заведения не проверяется; ключ — проверяется', () => {
    const heroes = ctx(['anna', 'tom']);
    expect(checkWorldPair(pair('anna--tom'), heroes, notFounded).map((e) => e.path)).toEqual([
      'key',
    ]);
    expect(checkWorldPair(pair('anna--tom'), heroes, null)).toEqual([]);
    expect(checkWorldPair(pair('tom--anna'), heroes, null).map((e) => e.path)).toEqual(['key']);
  });

  it('ссылка героя на ключ пары — неизвестный ключ: адресат отношения и реплики — герой', () => {
    const c = {
      ...ctx(['oblomov', 'olga']),
      entityKeys: new Set(['oblomov', 'olga', 'oblomov--olga']),
    };
    expect(
      checkWorldRefs(
        entity({
          relations: [{ to: 'oblomov--olga', label: 'pair' }],
          quotes: [{ ...quote(), speakerKey: 'oblomov--olga' }],
        }),
        c,
      ).map((e) => e.path),
    ).toEqual(['relations.0.to', 'quotes.0.speakerKey']);
  });

  it('pairMembers: ровно одно «--» и обе половины не пусты', () => {
    expect(pairMembers('anna--tom')).toEqual(['anna', 'tom']);
    expect(pairMembers('anna-lee--tom')).toEqual(['anna-lee', 'tom']);
    for (const key of ['anna', 'anna---tom', 'a--b--c', '--tom', 'anna--']) {
      expect(pairMembers(key)).toBeNull();
    }
  });

  it('pairEvidenceOf: связь в анализе в любую сторону; главы и общие главы из присутствия героев', () => {
    const evidence = pairEvidenceOf(
      [{ key: 'tom', relations: [{ to: 'anna', label: 'x' }] }],
      new Map<string, unknown>([
        ['anna', { chapters: [1, 2, 3], coPresence: { tom: [3, 2] } }],
        ['tom', { chapters: [2, 3] }],
      ]),
    );
    expect(evidence('anna', 'tom')).toEqual({
      isLinked: true,
      chaptersA: 3,
      chaptersB: 2,
      common: 2,
    });
    // Присутствие не посчитано (нет строки или нет `chapters`) — `null`, а не 0.
    expect(evidence('anna', 'olga')).toEqual({
      isLinked: false,
      chaptersA: 3,
      chaptersB: null,
      common: 0,
    });
  });
});

describe('ключ пары и ключ героя вида пары (F08-8e-1, LEGACY-507, решение арбитра Q7)', () => {
  it('worldPairKey: по алфавиту по коду символа; один герой, `--`, `-` по краю и ключ длиннее 60 — нет пары', () => {
    expect(worldPairKey('sonya', 'raskolnikov')).toBe('raskolnikov--sonya');
    expect(worldPairKey('a9', 'a10')).toBe('a10--a9');
    expect(worldPairKey('anna', 'anna')).toBeNull();
    expect(worldPairKey('anna--tom', 'boris')).toBeNull();
    expect(worldPairKey('anna-', 'boris')).toBeNull();
    expect(worldPairKey('-anna', '-boris')).toBeNull();
    expect(worldPairKey('-anna', 'boris')).toBe('-anna--boris');
    expect(worldPairKey('a'.repeat(30), 'b'.repeat(29))).toBeNull();
    expect(worldPairKey('a'.repeat(29), 'b'.repeat(29))).toBe(
      `${'a'.repeat(29)}--${'b'.repeat(29)}`,
    );
  });

  it('новый герой или смена типа на героя с `--` в ключе — отказ путём key; заведённый герой — без отказа', () => {
    const hero = { key: 'anna--tom', type: 'character' as const };
    expect(checkCharacterKey(hero, null)).toEqual([
      { path: 'key', message: expect.stringContaining('"--"') },
    ]);
    expect(checkCharacterKey(hero, 'pair')).toEqual([
      { path: 'key', message: expect.stringContaining('"--"') },
    ]);
    expect(checkCharacterKey(hero, 'character')).toEqual([]);
    expect(checkCharacterKey({ key: 'anna-tom', type: 'character' }, null)).toEqual([]);
    expect(checkCharacterKey({ key: 'anna--tom', type: 'pair' }, null)).toEqual([]);
  });
});

describe('правила записи пары, общие с ходом мира (F08-8e-1, ревью круга 3)', () => {
  it('characterKeyRefused: ключ с «--» у строки, которая не герой; заведённый герой — нет', () => {
    expect(characterKeyRefused('anna--tom', null)).toBe(true);
    expect(characterKeyRefused('anna--tom', 'pair')).toBe(true);
    expect(characterKeyRefused('anna--tom', 'character')).toBe(false);
    expect(characterKeyRefused('anna-tom', null)).toBe(false);
  });

  it('missingPairMembers: герои ключа, которых нет героями версии, без повторов', () => {
    expect(missingPairMembers(['anna', 'tom'], new Set(['anna']))).toEqual(['tom']);
    expect(missingPairMembers(['anna', 'anna'], new Set())).toEqual(['anna']);
    expect(missingPairMembers(['anna', 'tom'], new Set(['anna', 'tom']))).toEqual([]);
  });

  it('pairKeyTaken: ключ занят сущностью не-парой; нет строки или пара — не занят', () => {
    expect(pairKeyTaken('character')).toBe(true);
    expect(pairKeyTaken('pair')).toBe(false);
    expect(pairKeyTaken(undefined)).toBe(false);
    expect(pairKeyTaken(null)).toBe(false);
  });

  it('savedMentionsOf: одно чтение присутствия по ключам версии; без ключей — без запроса', async () => {
    const findMany = jest.fn().mockResolvedValue([{ key: 'anna', mentions: { chapters: [1] } }]);
    const client = { bookWorldEntity: { findMany } } as never;
    expect(await savedMentionsOf(client, 'v1', [])).toEqual(new Map());
    expect(findMany).not.toHaveBeenCalled();
    const got = await savedMentionsOf(client, 'v1', ['anna', 'tom', 'anna']);
    expect(got).toEqual(new Map([['anna', { chapters: [1] }]]));
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(findMany).toHaveBeenCalledWith({
      where: { bookVersionId: 'v1', key: { in: ['anna', 'tom'] } },
      select: { key: true, mentions: true },
      take: 100,
    });
  });
});

describe('entitiesReferring (F08-12a, ревью круга 4): одно правило удаления и смены типа героя', () => {
  const others = [
    { key: 'oblomov', blocks: { relations: [{ to: 'zakhar', label: 'Servant' }] } },
    {
      key: 'olga',
      blocks: { quotes: [{ text: 'Q', chapter: 1, interpretation: 'I', speakerKey: 'zakhar' }] },
    },
    {
      key: 'anna--zakhar',
      blocks: { quotes: [{ text: 'Q', chapter: 1, interpretation: 'I', aboutKey: 'zakhar' }] },
    },
    { key: 'tarantiev', blocks: { relations: [{ to: 'oblomov', label: 'Friend' }] } },
  ];

  it('ссылки relations, speakerKey и aboutKey держат героя', () => {
    expect(entitiesReferring('zakhar', others, new Set())).toEqual([
      'oblomov',
      'olga',
      'anna--zakhar',
    ]);
  });

  it('ключ героя анализа держится ссылкой — ссылающихся нет', () => {
    expect(entitiesReferring('zakhar', others, new Set(['zakhar']))).toEqual([]);
  });

  it('ссылка на себя не в счёт; без ссылок — пусто', () => {
    const self = [{ key: 'zakhar', blocks: { relations: [{ to: 'zakhar', label: 'Self' }] } }];
    expect(entitiesReferring('zakhar', self, new Set())).toEqual([]);
    expect(entitiesReferring('nobody', others, new Set())).toEqual([]);
  });
});
