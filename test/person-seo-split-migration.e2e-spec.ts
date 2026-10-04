import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Language, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261004120000_legacy_400_split_person_seo/migration.sql',
);

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

/** Рецепт отката из шапки миграции — ровно тот текст, который исполнят после выката. */
const rollback = (): string => {
  const recipe = /^-- (UPDATE "PersonTranslation"[\s\S]*?);$/m.exec(
    readFileSync(MIGRATION, 'utf8'),
  );
  if (!recipe) throw new Error('В шапке миграции нет рецепта отката');
  return recipe[1].replace(/^--\s?/gm, '');
};

/** Все скалярные поля `Seo` заполнены: копия обязана перенести каждое. */
const fullSeo = (tag: string): Prisma.SeoCreateInput => ({
  metaTitle: `${tag} metaTitle`,
  metaDescription: `${tag} metaDescription`,
  canonicalUrl: `https://ex.com/${tag}/canonical`,
  robots: 'noindex, follow',
  ogTitle: `${tag} ogTitle`,
  ogDescription: `${tag} ogDescription`,
  ogType: 'profile',
  ogUrl: `https://ex.com/${tag}/og`,
  ogImageUrl: `https://cdn.ex.com/${tag}.png`,
  ogImageAlt: `${tag} ogImageAlt`,
  twitterCard: 'summary_large_image',
  twitterSite: '@site',
  twitterCreator: '@creator',
  eventName: `${tag} eventName`,
  eventDescription: `${tag} eventDescription`,
  eventStartDate: new Date('2026-01-02T03:04:05Z'),
  eventEndDate: new Date('2026-01-03T03:04:05Z'),
  eventUrl: `https://ex.com/${tag}/event`,
  eventImageUrl: `https://cdn.ex.com/${tag}-event.png`,
  eventLocationName: 'Hall',
  eventLocationStreet: 'Street 1',
  eventLocationCity: 'City',
  eventLocationRegion: 'Region',
  eventLocationPostal: '101000',
  eventLocationCountry: 'RU',
  createdAt: new Date('2025-05-05T05:05:05Z'),
});

/**
 * 🔴 `LEGACY-400`, решение арбитра T99. Миграция фазы 14 скопировала `seoId` автора в перевод
 * персоны, и одна строка `Seo` принадлежала обоим. Миграция даёт персоне копию; здесь её SQL
 * исполняется на живом Postgres по строкам, которые оставила фаза 14, и по состояниям
 * оборванного прогона.
 */
describe('LEGACY-400 — раздельные Seo у автора и персоны (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const authorIds: string[] = [];
  const personIds: string[] = [];
  const personTrIds: string[] = [];
  const seoIds: number[] = [];
  const tagIds: string[] = [];
  const categoryIds: string[] = [];
  const pageIds: string[] = [];
  let bookId = '';

  const seo = async (data: Prisma.SeoCreateInput) => {
    const row = await prisma.seo.create({ data });
    seoIds.push(row.id);
    return row.id;
  };
  const author = async (tag: string, seoId: number) => {
    const row = await prisma.author.create({
      data: {
        translations: {
          create: { language: Language.en, slug: `l400-a-${tag}-${stamp}`, name: tag, seoId },
        },
      },
    });
    authorIds.push(row.id);
  };
  const person = async (tag: string, seoId: number) => {
    const row = await prisma.person.create({
      data: {
        canonicalName: `l400-${tag}-${stamp}`,
        translations: {
          create: {
            language: Language.en,
            slug: `l400-p-${tag}-${stamp}`,
            displayName: tag,
            seoId,
          },
        },
      },
      include: { translations: true },
    });
    personIds.push(row.id);
    personTrIds.push(row.translations[0].id);
    return row.translations[0].id;
  };
  /** Свободный id из последовательности `Seo` — как его выдал бы оборванный первый прогон. */
  const freeSeoId = async () => {
    const [{ id }] = await prisma.$queryRaw<{ id: number }[]>`
      SELECT nextval(pg_get_serial_sequence('"Seo"', 'id'))::int AS id`;
    seoIds.push(id);
    return id;
  };
  const seoIdOf = async (personTrId: string) =>
    (await prisma.personTranslation.findUniqueOrThrow({ where: { id: personTrId } })).seoId;
  const authorSeoIds = async (ids: number[]) =>
    prisma.authorTranslation.count({ where: { seoId: { in: ids } } });

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    const pairs = await prisma?.legacy400PersonSeo.findMany({
      where: { personTranslationId: { in: personTrIds } },
    });
    await prisma?.legacy400PersonSeo.deleteMany({
      where: { personTranslationId: { in: personTrIds } },
    });
    await prisma?.person.deleteMany({ where: { id: { in: personIds } } });
    await prisma?.author.deleteMany({ where: { id: { in: authorIds } } });
    await prisma?.tag.deleteMany({ where: { id: { in: tagIds } } });
    await prisma?.category.deleteMany({ where: { id: { in: categoryIds } } });
    await prisma?.page.deleteMany({ where: { id: { in: pageIds } } });
    await prisma?.bookVersion.deleteMany({ where: { bookId } });
    await prisma?.book.deleteMany({ where: { id: bookId } });
    await prisma?.seo.deleteMany({
      where: { id: { in: [...seoIds, ...(pairs ?? []).map((p) => p.newSeoId)] } },
    });
    await moduleRef?.close();
  });

  it('разводит общие Seo, не трогает чужие строки, переживает обрыв и откатывается рецептом', async () => {
    // Общая строка фазы 14.
    const shared = await seo(fullSeo('shared'));
    await author('shared', shared);
    const sharedTr = await person('shared', shared);

    // Своя строка персоны — миграция её не касается.
    const own = await seo({ metaTitle: 'own' });
    const ownTr = await person('own', own);

    // Занятые строки `Seo`: по одной у каждого из шести владельцев (персона — `own` выше).
    const owned: Record<string, number> = { person: own };
    owned.author = await seo({ metaTitle: 'owner author' });
    await author('owner', owned.author);
    owned.tag = await seo({ metaTitle: 'owner tag' });
    const tag = await prisma.tag.create({
      data: {
        name: 'l400',
        slug: `l400-${stamp}`,
        key: `l400-${stamp}`,
        translations: {
          create: { language: Language.en, name: 'l400', slug: `l400-${stamp}`, seoId: owned.tag },
        },
      },
    });
    tagIds.push(tag.id);
    owned.category = await seo({ metaTitle: 'owner category' });
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: 'l400',
        slug: `l400-${stamp}`,
        key: `l400-${stamp}`,
        translations: {
          create: {
            language: Language.en,
            name: 'l400',
            slug: `l400-${stamp}`,
            seoId: owned.category,
          },
        },
      },
    });
    categoryIds.push(category.id);
    owned.page = await seo({ metaTitle: 'owner page' });
    const page = await prisma.page.create({
      data: {
        slug: `l400-${stamp}`,
        title: 'l400',
        type: 'generic',
        content: 'c',
        language: Language.en,
        seoId: owned.page,
      },
    });
    pageIds.push(page.id);
    owned.version = await seo({ metaTitle: 'owner version' });
    bookId = (await createBookFixture(prisma, `l400-${stamp}`)).id;
    await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'en',
        title: 't',
        author: 'a',
        description: 'd',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        seoId: owned.version,
      },
    });

    // Ничья строка с чужой метой — таких на проде 982.
    owned.orphan = await seo({ metaTitle: 'owner orphan' });

    // Пара, чей новый id уже занят строкой любого владельца или ничьей: переключать на чужую мету нельзя.
    // У владельцев старая строка — двойник занятой по всем полям вместе с `createdAt`: сверка копии
    // её пропустит, остановить переключение должна проверка владельцев. Ничью строку от копии
    // отличает только содержимое, поэтому её пара — с другой метой.
    const clashes: { tr: string; old: number; owner: number }[] = [];
    for (const [kind, owner] of Object.entries(owned)) {
      const taken = await prisma.seo.findUniqueOrThrow({ where: { id: owner } });
      const old = await seo(
        kind === 'orphan'
          ? { metaTitle: 'clash orphan' }
          : { metaTitle: taken.metaTitle, createdAt: taken.createdAt },
      );
      await author(`clash-${kind}`, old);
      const tr = await person(`clash-${kind}`, old);
      await prisma.legacy400PersonSeo.create({
        data: { personTranslationId: tr, oldSeoId: old, newSeoId: owner },
      });
      clashes.push({ tr, old, owner });
    }

    // Оборванный прогон: пара записана, копии ещё нет — повтор доводит.
    const torn = await seo({ metaTitle: 'torn' });
    await author('torn', torn);
    const tornTr = await person('torn', torn);
    const tornNew = await freeSeoId();
    await prisma.legacy400PersonSeo.create({
      data: { personTranslationId: tornTr, oldSeoId: torn, newSeoId: tornNew },
    });

    // Пара записана, но перевод с тех пор перепривязан: возвращать его на копию нельзя.
    const moved = await seo({ metaTitle: 'moved' });
    await author('moved', moved);
    const movedOwn = await seo({ metaTitle: 'moved own' });
    const movedTr = await person('moved', movedOwn);
    const movedNew = await freeSeoId();
    await prisma.legacy400PersonSeo.create({
      data: { personTranslationId: movedTr, oldSeoId: moved, newSeoId: movedNew },
    });

    // Отставшая последовательность (импорт или восстановление с явными id): следующий `nextval`
    // выдал бы id занятой строки. Миграция обязана подтянуть её к MAX("id") до выдачи.
    const lag = await seo({ metaTitle: 'lag' });
    await author('lag', lag);
    const lagTr = await person('lag', lag);
    await prisma.$queryRaw`SELECT setval(pg_get_serial_sequence('"Seo"', 'id'), ${own - 1}::int)`;

    for (let run = 0; run < 2; run++) {
      for (const sql of statements()) await prisma.$executeRawUnsafe(sql);
    }

    const sharedNew = await seoIdOf(sharedTr);
    expect(sharedNew).not.toBeNull();
    expect(sharedNew).not.toBe(shared);
    expect(await authorSeoIds([shared])).toBe(1);
    const source = await prisma.seo.findUniqueOrThrow({ where: { id: shared } });
    const copy = await prisma.seo.findUniqueOrThrow({ where: { id: sharedNew! } });
    // Ключи — каждое заполненное поле фикстуры, включая `createdAt`; `id` и `updatedAt` у копии свои.
    const fields = Object.keys(fullSeo('keys')) as (keyof typeof source)[];
    const pick = (row: typeof source) => fields.map((key) => [key, row[key]]);
    expect(pick(copy)).toEqual(pick(source));

    expect(await seoIdOf(ownTr)).toBe(own);
    for (const { tr, old } of clashes) expect(await seoIdOf(tr)).toBe(old);
    for (const [kind, owner] of Object.entries(owned)) {
      expect(await prisma.seo.findUniqueOrThrow({ where: { id: owner } })).toMatchObject({
        metaTitle: kind === 'person' ? 'own' : `owner ${kind}`,
      });
    }
    const lagNew = await seoIdOf(lagTr);
    expect(lagNew).not.toBe(lag);
    expect(await prisma.seo.findUniqueOrThrow({ where: { id: lagNew! } })).toMatchObject({
      metaTitle: 'lag',
    });
    expect(await seoIdOf(tornTr)).toBe(tornNew);
    expect(await prisma.seo.findUniqueOrThrow({ where: { id: tornNew } })).toMatchObject({
      metaTitle: 'torn',
    });
    expect(await seoIdOf(movedTr)).toBe(movedOwn);
    expect(await prisma.seo.findUnique({ where: { id: movedNew } })).toBeNull();

    const pair = await prisma.legacy400PersonSeo.findUniqueOrThrow({
      where: { personTranslationId: sharedTr },
    });
    expect(pair).toEqual({ personTranslationId: sharedTr, oldSeoId: shared, newSeoId: sharedNew });
    expect(await authorSeoIds([sharedNew!, tornNew])).toBe(0);

    // После разведения правка меты персоны не меняет мету автора.
    await prisma.seo.update({ where: { id: sharedNew! }, data: { metaTitle: 'Персона' } });
    expect((await prisma.seo.findUniqueOrThrow({ where: { id: shared } })).metaTitle).toBe(
      'shared metaTitle',
    );

    // Рецепт отката из шапки возвращает общую строку и не трогает перепривязанный перевод.
    await prisma.$executeRawUnsafe(rollback());
    expect(await seoIdOf(sharedTr)).toBe(shared);
    expect(await seoIdOf(tornTr)).toBe(torn);
    expect(await seoIdOf(movedTr)).toBe(movedOwn);
    expect(await seoIdOf(lagTr)).toBe(lag);
    for (const { tr, old } of clashes) expect(await seoIdOf(tr)).toBe(old);
  });
});
