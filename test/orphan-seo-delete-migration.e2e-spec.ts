import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Language, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SEO_OWNER_RELATIONS } from '../src/shared/seo/seo-orphan.util';
import { createBookFixture } from './helpers/book-fixture';
import { backendPid, waitBlockedBy } from './helpers/lock-probe';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261004180000_legacy_400_delete_orphan_seo/migration.sql',
);

/**
 * Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. Блок `DO $$ … $$`
 * остаётся одним оператором — внутри него замок и удаление обязаны идти одной командой.
 */
const statements = (): string[] => {
  const bodies: string[] = [];
  return readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .replace(/\$\$[\s\S]*?\$\$/g, (body) => `@@dollar-block-${bodies.push(body) - 1}@@`)
    .split(/;\s*$/m)
    .map((sql) =>
      sql.replace(/@@dollar-block-(\d+)@@/g, (_m, idx: string) => bodies[Number(idx)]).trim(),
    )
    .filter(Boolean);
};

/** Таблицы владельцев, которые оператор проверяет через `NOT EXISTS`. */
const ownerTables = (sql: string): string[] =>
  [...sql.matchAll(/NOT EXISTS \(SELECT 1 FROM "(\w+)" o WHERE o\."seoId" = s\."id"\)/g)]
    .map((match) => match[1])
    .sort();

/** Рецепт отката из шапки миграции — ровно тот текст, который исполнят после выката. */
const rollback = (): string => {
  const recipe = /^-- (INSERT INTO "Seo"[\s\S]*?);$/m.exec(readFileSync(MIGRATION, 'utf8'));
  if (!recipe) throw new Error('В шапке миграции нет рецепта отката');
  return recipe[1].replace(/^--\s?/gm, '');
};

/** Все скалярные поля `Seo` заполнены: копия и откат обязаны перенести каждое. */
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
  eventStartDate: new Date('2026-01-02T03:04:05.678Z'),
  eventEndDate: new Date('2026-01-03T03:04:05.678Z'),
  eventUrl: `https://ex.com/${tag}/event`,
  eventImageUrl: `https://cdn.ex.com/${tag}-event.png`,
  eventLocationName: 'Hall',
  eventLocationStreet: 'Street 1',
  eventLocationCity: 'City',
  eventLocationRegion: 'Region',
  eventLocationPostal: '101000',
  eventLocationCountry: 'RU',
  createdAt: new Date('2025-05-05T05:05:05.123Z'),
});

/** Откат транзакции после проверок: удаление сирот не должно уйти в общую базу e2e. */
class Rollback extends Error {}

/**
 * 🔴 `LEGACY-400`, слово владельца 04.10.2026. Миграция удаляет `Seo` без единого из шести владельцев,
 * сперва копируя строку целиком в `_legacy400_orphan_seo`. Здесь её SQL исполняется на живом Postgres
 * внутри транзакции, которая в конце откатывается: миграция удаляет всех сирот базы, а не только
 * строки этой спеки.
 */
describe('LEGACY-400 — удаление ничьих Seo с резервной копией (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const seoIds: number[] = [];
  let authorId = '';
  let personId = '';
  let tagId = '';
  let categoryId = '';
  let pageId = '';
  let bookId = '';
  let racePageSlug = '';

  const seo = async (data: Prisma.SeoCreateInput) => {
    const row = await prisma.seo.create({ data });
    seoIds.push(row.id);
    return row.id;
  };

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
  });

  afterAll(async () => {
    await prisma?.person.deleteMany({ where: { id: personId } });
    await prisma?.author.deleteMany({ where: { id: authorId } });
    await prisma?.tag.deleteMany({ where: { id: tagId } });
    await prisma?.category.deleteMany({ where: { id: categoryId } });
    await prisma?.page.deleteMany({ where: { OR: [{ id: pageId }, { slug: racePageSlug }] } });
    await prisma?.bookVersion.deleteMany({ where: { bookId } });
    await prisma?.book.deleteMany({ where: { id: bookId } });
    await prisma?.seo.deleteMany({ where: { id: { in: seoIds } } });
    await moduleRef?.close();
  });

  it('удаляет только ничьи строки, копирует их целиком, переживает повтор и откатывается рецептом', async () => {
    // По одной занятой строке у каждого из шести владельцев — ни одна не должна пропасть.
    const owned: Record<string, number> = {};
    owned.author = await seo(fullSeo('author'));
    authorId = (
      await prisma.author.create({
        data: {
          translations: {
            create: {
              language: Language.en,
              slug: `l400o-a-${stamp}`,
              name: 'a',
              seoId: owned.author,
            },
          },
        },
      })
    ).id;
    owned.person = await seo({ metaTitle: 'owner person' });
    personId = (
      await prisma.person.create({
        data: {
          canonicalName: `l400o-${stamp}`,
          translations: {
            create: {
              language: Language.en,
              slug: `l400o-p-${stamp}`,
              displayName: 'p',
              seoId: owned.person,
            },
          },
        },
      })
    ).id;
    owned.tag = await seo({ metaTitle: 'owner tag' });
    tagId = (
      await prisma.tag.create({
        data: {
          name: 'l400o',
          slug: `l400o-${stamp}`,
          key: `l400o-${stamp}`,
          translations: {
            create: { language: Language.en, name: 't', slug: `l400o-${stamp}`, seoId: owned.tag },
          },
        },
      })
    ).id;
    owned.category = await seo({ metaTitle: 'owner category' });
    categoryId = (
      await prisma.category.create({
        data: {
          type: 'genre',
          name: 'l400o',
          slug: `l400o-${stamp}`,
          key: `l400o-${stamp}`,
          translations: {
            create: {
              language: Language.en,
              name: 'c',
              slug: `l400o-${stamp}`,
              seoId: owned.category,
            },
          },
        },
      })
    ).id;
    owned.page = await seo({ metaTitle: 'owner page' });
    pageId = (
      await prisma.page.create({
        data: {
          slug: `l400o-${stamp}`,
          title: 'l400o',
          type: 'generic',
          content: 'c',
          language: Language.en,
          seoId: owned.page,
        },
      })
    ).id;
    owned.version = await seo({ metaTitle: 'owner version' });
    bookId = (await createBookFixture(prisma, `l400o-${stamp}`)).id;
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

    // Сироты: со всеми полями (откат обязан вернуть каждое) и пустая.
    const orphanFull = await seo(fullSeo('orphan'));
    const orphanBare = await seo({});
    // Сирота, которую до миграции привязывает страница (legacy `seoId`): она уже не ничья.
    const orphanAttached = await seo({ metaTitle: 'attached' });
    // Сирота, которую до миграции правят: копия обязана нести то, что удалено, а не прежнее.
    const orphanEdited = await seo({ metaTitle: 'edited later' });
    // Сирота, которую до миграции удаляет само приложение: в резервную таблицу она попасть не должна.
    const orphanGone = await seo({ metaTitle: 'gone' });

    const [create, remove] = statements();
    expect(statements()).toHaveLength(2);
    expect(create).toMatch(/^CREATE TABLE IF NOT EXISTS "_legacy400_orphan_seo"/);
    // Замок, копия и удаление — один блок и именно в этом порядке.
    expect(remove).toMatch(
      /^DO \$\$[\s\S]*FOR UPDATE OF s\s*\) locked;\s*INSERT INTO "_legacy400_orphan_seo"[\s\S]*;\s*DELETE FROM "Seo"/,
    );

    let checked = false;
    await prisma
      .$transaction(
        async (tx) => {
          const run = async () => {
            for (const sql of statements()) await tx.$executeRawUnsafe(sql);
          };
          const exists = async (id: number) =>
            (await tx.seo.findUnique({ where: { id } })) !== null;
          const backups = async (ids: number[]) =>
            (await tx.legacy400OrphanSeo.findMany({ where: { id: { in: ids } } })).map(
              (backup) => backup.id,
            );

          await tx.page.create({
            data: {
              slug: `l400o-late-${stamp}`,
              title: 'late',
              type: 'generic',
              content: 'c',
              language: Language.en,
              seoId: orphanAttached,
            },
          });
          await tx.seo.update({ where: { id: orphanEdited }, data: { metaTitle: 'edited' } });
          await tx.seo.delete({ where: { id: orphanGone } });
          const before = await tx.seo.findMany({
            where: { id: { in: [orphanFull, orphanBare, orphanEdited] } },
          });
          expect(before).toHaveLength(3);

          await run();
          for (const id of Object.values(owned)) expect(await exists(id)).toBe(true);
          expect(await exists(orphanAttached)).toBe(true);
          for (const id of [orphanFull, orphanBare, orphanEdited]) {
            expect(await exists(id)).toBe(false);
          }
          // В резервной таблице ровно удалённые строки, и в том виде, в каком их удалили.
          expect((await backups(Object.values(owned))).length).toBe(0);
          expect(await backups([orphanAttached, orphanGone])).toHaveLength(0);
          expect((await backups([orphanFull, orphanBare, orphanEdited])).sort()).toEqual(
            [orphanFull, orphanBare, orphanEdited].sort(),
          );
          const edited = await tx.legacy400OrphanSeo.findUniqueOrThrow({
            where: { id: orphanEdited },
          });
          expect((edited.row as { metaTitle: string }).metaTitle).toBe('edited');

          // Повтор ничего не меняет: удалять больше нечего, копии прошлого прогона на месте.
          await run();
          expect(await backups([orphanFull, orphanBare, orphanEdited])).toHaveLength(3);
          expect(await exists(orphanAttached)).toBe(true);
          for (const id of Object.values(owned)) expect(await exists(id)).toBe(true);

          // Рецепт отката из шапки возвращает строки байт в байт, включая `id`, даты и пустые поля.
          await tx.$executeRawUnsafe(rollback());
          const restored = await tx.seo.findMany({
            where: { id: { in: [orphanFull, orphanBare, orphanEdited] } },
          });
          const byId = (rows: typeof before) => [...rows].sort((left, right) => left.id - right.id);
          expect(byId(restored)).toEqual(byId(before));
          expect(await exists(orphanGone)).toBe(false);
          // Повтор рецепта ничего не дублирует.
          await tx.$executeRawUnsafe(rollback());
          checked = true;
          throw new Rollback();
        },
        { timeout: 120_000, maxWait: 30_000 },
      )
      .catch((e: unknown) => {
        if (!(e instanceof Rollback)) throw e;
      });
    expect(checked).toBe(true);

    // Транзакция откатана: общая база e2e осталась как была.
    for (const id of [orphanFull, orphanBare, orphanAttached, orphanEdited, orphanGone]) {
      expect(await prisma.seo.findUnique({ where: { id } })).not.toBeNull();
    }
  });

  it('проверяет ровно шесть владельцев из схемы — в замке, копии и удалении', () => {
    const seoModel = Prisma.dmmf.datamodel.models.find((model) => model.name === 'Seo');
    const owners = (seoModel?.fields ?? [])
      .filter((field) => (SEO_OWNER_RELATIONS as readonly string[]).includes(field.name))
      .map((field) => field.type)
      .sort();
    expect(owners).toHaveLength(SEO_OWNER_RELATIONS.length);
    const [, remove] = statements();
    expect(ownerTables(remove)).toEqual([...owners, ...owners, ...owners].sort());
  });

  it('не удаляет строку, которую в это время привязывает страница из соседней транзакции', async () => {
    const orphanRace = await seo({ metaTitle: 'race' });
    const raceSlug = `l400o-race-${stamp}`;
    racePageSlug = raceSlug;

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let attached!: (pid: number) => void;
    const attachedPid = new Promise<number>((resolve) => (attached = resolve));

    // Соседняя транзакция — старый образ, привязывающий ничью строку legacy `seoId`: внешний ключ держит
    // на ней FOR KEY SHARE до коммита.
    const attach = prisma.$transaction(
      async (txB) => {
        await txB.page.create({
          data: {
            slug: raceSlug,
            title: 'race',
            type: 'generic',
            content: 'c',
            language: Language.en,
            seoId: orphanRace,
          },
        });
        attached(await backendPid(txB));
        await gate;
      },
      { timeout: 60_000, maxWait: 30_000 },
    );
    const holder = await attachedPid;

    let checked = false;
    await prisma
      .$transaction(
        async (tx) => {
          const [create, remove] = statements();
          await tx.$executeRawUnsafe(create);
          // `then` запускает запрос сразу: без него ленивый промис Prisma ушёл бы в базу только на `await`.
          const removing = tx.$executeRawUnsafe(remove).then(
            () => null,
            (error: unknown) => error,
          );
          // Удаление встало в очередь за привязкой — иначе проба ничего не проверяет.
          expect(await waitBlockedBy(prisma, holder)).toBe(true);
          release();
          await attach;
          expect(await removing).toBeNull();

          expect(await tx.seo.findUnique({ where: { id: orphanRace } })).not.toBeNull();
          const page = await tx.page.findFirstOrThrow({ where: { slug: raceSlug } });
          expect(page.seoId).toBe(orphanRace);
          checked = true;
          throw new Rollback();
        },
        { timeout: 120_000, maxWait: 30_000 },
      )
      .catch(async (e: unknown) => {
        // Соседняя транзакция закрывается до выхода из теста при любом исходе: иначе `afterAll` убирал бы
        // страницу раньше её коммита, а отказ пробы тонул бы в шуме.
        release();
        await attach;
        if (!(e instanceof Rollback)) throw e;
      });
    expect(checked).toBe(true);
  });
});
