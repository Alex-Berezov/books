import { BadRequestException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Language, Prisma } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { PagesService } from '../src/modules/pages/pages.service';
import { CategoryService } from '../src/modules/category/category.service';
import { TagsService } from '../src/modules/tags/tags.service';
import { AuthorService } from '../src/modules/author/author.service';
import { BookVersionService } from '../src/modules/book-version/book-version.service';
import { BookService } from '../src/modules/book/book.service';
import { PersonsService } from '../src/modules/persons/persons.service';
import { SeoService } from '../src/modules/seo/seo.service';
import { createBookFixture } from './helpers/book-fixture';
import { deleteVersionsWithSeo } from '../prisma/scripts/cleanup-duplicate-book-versions';

/**
 * 🔴 `LEGACY-400`, пачка `T55b`. `Seo` не каскадируется ни от страницы, ни от перевода
 * категории: удаление и отвязка оставляли строку, которую больше никто не найдёт, а её
 * адресные колонки держали медиа от уборки (`LEGACY-413`). Строка удаляется, только если
 * её не держит никто из шести владельцев (`src/shared/seo/seo-orphan.util.ts`).
 *
 * `LEGACY-320`, тема владельца 3 (решение владельца 27.09.2026): язык существующей страницы
 * не меняется — перевод заводится отдельной страницей.
 *
 * HTTP-слой не поднимается — по той же причине, что в `tag-row-lock.e2e-spec.ts`.
 */
describe('T55b — Seo без сирот, язык страницы неизменяем (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let pages: PagesService;
  let categories: CategoryService;
  let tags: TagsService;
  let authors: AuthorService;
  let versions: BookVersionService;
  let books: BookService;
  let persons: PersonsService;
  let seo: SeoService;
  const authorIds: string[] = [];
  const personIds: string[] = [];

  const prefix = `seoorph-${Date.now()}`;
  const seoIds: number[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    pages = moduleRef.get(PagesService);
    categories = moduleRef.get(CategoryService);
    tags = moduleRef.get(TagsService);
    authors = moduleRef.get(AuthorService);
    versions = moduleRef.get(BookVersionService);
    books = moduleRef.get(BookService);
    persons = moduleRef.get(PersonsService);
    seo = moduleRef.get(SeoService);
    await moduleRef.init();
  });

  afterAll(async () => {
    try {
      await prisma?.slugRedirect.deleteMany({ where: { oldSlug: { startsWith: prefix } } });
      await prisma?.page.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma?.category.deleteMany({ where: { key: { startsWith: prefix } } });
      await prisma?.tag.deleteMany({ where: { key: { startsWith: prefix } } });
      await prisma?.author.deleteMany({ where: { id: { in: authorIds } } });
      await prisma?.person.deleteMany({ where: { id: { in: personIds } } });
      await prisma?.seo.deleteMany({ where: { metaTitle: { startsWith: prefix } } });
      await prisma?.book.deleteMany({ where: { slug: { startsWith: prefix } } });
      await prisma?.seo.deleteMany({ where: { id: { in: seoIds } } });
    } finally {
      await moduleRef?.close();
    }
  });

  const seoExists = async (id: number) =>
    (await prisma.seo.findUnique({ where: { id }, select: { id: true } })) !== null;

  const newSeo = async () => {
    const seo = await prisma.seo.create({ data: { metaTitle: `${prefix} seo` } });
    seoIds.push(seo.id);
    return seo.id;
  };

  const newPage = (slug: string, seoId?: number) =>
    prisma.page.create({
      data: {
        slug: `${prefix}-${slug}`,
        title: 'T',
        type: 'generic',
        content: 'c',
        language: Language.en,
        ...(seoId ? { seoId } : {}),
      },
    });

  it('страница: отвязка Seo удаляет ничью строку', async () => {
    const seoId = await newSeo();
    const page = await newPage('detach', seoId);

    await pages.update(page.id, { seo: { metaTitle: null } } as never, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  it('страница: удаление убирает её Seo', async () => {
    const seoId = await newSeo();
    const page = await newPage('remove', seoId);

    await pages.remove(page.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  it('страница: legacy seoId, занятый переводом категории, — 400, строка не делится', async () => {
    const seoId = await newSeo();
    await prisma.category.create({
      data: {
        type: 'genre',
        name: `${prefix} owner`,
        slug: `${prefix}-owner`,
        key: `${prefix}-owner`,
        translations: {
          create: { language: Language.en, name: 'O', slug: `${prefix}-owner-en`, seoId },
        },
      },
    });
    const page = await newPage('steal');

    await expect(pages.update(page.id, { seoId } as never, 'e2e-actor')).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const after = await prisma.page.findUnique({ where: { id: page.id }, select: { seoId: true } });
    expect(after?.seoId).toBeNull();
  }, 60_000);

  it('категория: удаление термина убирает Seo его переводов', async () => {
    const seoId = await newSeo();
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `${prefix} cat`,
        slug: `${prefix}-cat`,
        key: `${prefix}-cat`,
        translations: {
          create: { language: Language.en, name: 'C', slug: `${prefix}-cat-en`, seoId },
        },
      },
    });

    await categories.remove(category.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  /**
   * Общая строка `Seo` (так бывает в данных до `T55b`: `@unique` на `seoId` стоит только внутри
   * таблицы) переживает отвязку одного владельца, а второй её не теряет через `SetNull`.
   */
  it('общее Seo страницы и перевода категории переживает отвязку с обеих сторон', async () => {
    const seoId = await newSeo();
    const page = await newPage('shared', seoId);
    const category = await prisma.category.create({
      data: {
        type: 'genre',
        name: `${prefix} shared`,
        slug: `${prefix}-shared`,
        key: `${prefix}-shared`,
        translations: {
          create: { language: Language.en, name: 'S', slug: `${prefix}-shared-en`, seoId },
        },
      },
    });

    await pages.update(page.id, { seo: { metaTitle: null } } as never, 'e2e-actor');
    expect(await seoExists(seoId)).toBe(true);

    await prisma.page.update({ where: { id: page.id }, data: { seoId } });
    await categories.updateTranslation(category.id, Language.en, {
      seo: { metaTitle: null },
    } as never);
    expect(await seoExists(seoId)).toBe(true);
    const after = await prisma.page.findUnique({ where: { id: page.id }, select: { seoId: true } });
    expect(after?.seoId).toBe(seoId);
  }, 60_000);

  it('страница: seo и seoId вместе — seoId чужой сущности — 400, строка не делится', async () => {
    const seoId = await newSeo();
    await prisma.category.create({
      data: {
        type: 'genre',
        name: `${prefix} owner2`,
        slug: `${prefix}-owner2`,
        key: `${prefix}-owner2`,
        translations: {
          create: { language: Language.en, name: 'O', slug: `${prefix}-owner2-en`, seoId },
        },
      },
    });
    const page = await newPage('seo-and-id');

    await expect(
      pages.update(page.id, { seo: {}, seoId } as never, 'e2e-actor'),
    ).rejects.toBeInstanceOf(BadRequestException);

    const after = await prisma.page.findUnique({ where: { id: page.id }, select: { seoId: true } });
    expect(after?.seoId).toBeNull();
  }, 60_000);

  // Решение арбитра 27.09.2026 (`T55b`): теги и авторы — целиком, включая удаление сущности.
  it('тег: удаление убирает Seo его переводов', async () => {
    const seoId = await newSeo();
    const tag = await prisma.tag.create({
      data: {
        name: `${prefix} tag`,
        slug: `${prefix}-tag`,
        key: `${prefix}-tag`,
        translations: {
          create: { language: Language.en, name: 'T', slug: `${prefix}-tag-en`, seoId },
        },
      },
    });

    await tags.remove(tag.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  it('автор: пересоздание переводов правкой убирает прежнее ничьё Seo', async () => {
    const seoId = await newSeo();
    const author = await prisma.author.create({
      data: {
        translations: {
          create: { language: Language.en, name: 'A', slug: `${prefix}-auth-a`, seoId },
        },
      },
    });
    authorIds.push(author.id);

    await authors.update(author.id, {
      translations: [{ language: Language.en, name: 'A', slug: `${prefix}-auth-a` }],
    } as never);

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  it('автор: удаление убирает Seo его переводов', async () => {
    const seoId = await newSeo();
    const author = await prisma.author.create({
      data: {
        translations: {
          create: { language: Language.en, name: 'D', slug: `${prefix}-auth-del`, seoId },
        },
      },
    });
    authorIds.push(author.id);

    await authors.delete(author.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  const newVersion = async (tag: string, seoId?: number) => {
    const book = await createBookFixture(prisma, `${prefix}-${tag}`);
    return prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: Language.en,
        slug: `${prefix}-${tag}-v`,
        title: 'V',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        ...(seoId ? { seoId } : {}),
      },
    });
  };

  // `T55c` (решение владельца 27.09.2026): то же правило для версии книги.
  it('версия книги: смена языка — 400, адрес не трогается', async () => {
    const version = await newVersion('vlang');

    await expect(versions.update(version.id, { language: Language.ru } as never)).rejects.toThrow(
      'Book version language cannot be changed after creation; create a new version instead',
    );
    const after = await prisma.bookVersion.findUnique({
      where: { id: version.id },
      select: { language: true, slug: true },
    });
    expect(after).toEqual({ language: Language.en, slug: version.slug });
  }, 60_000);

  it('версия книги: удаление убирает её Seo', async () => {
    const seoId = await newSeo();
    const version = await newVersion('vseo', seoId);

    await versions.remove(version.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  // `LEGACY-400`, пачка `T80`: ручной скрипт удаления дублей версий убирал версии `deleteMany`
  // и оставлял их `Seo` сиротами. Общая строка со страницей остаётся у страницы.
  it('скрипт дублей версий: Seo удалённых версий убирается, общее со страницей остаётся', async () => {
    const ownSeoId = await newSeo();
    const sharedSeoId = await newSeo();
    const own = await newVersion('dup-own', ownSeoId);
    const shared = await newVersion('dup-shared', sharedSeoId);
    const bare = await newVersion('dup-bare');
    const page = await newPage('dup-shared', sharedSeoId);

    await deleteVersionsWithSeo(prisma, [own.id, shared.id, bare.id]);

    expect(
      await prisma.bookVersion.count({ where: { id: { in: [own.id, shared.id, bare.id] } } }),
    ).toBe(0);
    expect(await seoExists(ownSeoId)).toBe(false);
    expect(await seoExists(sharedSeoId)).toBe(true);
    const after = await prisma.page.findUnique({ where: { id: page.id }, select: { seoId: true } });
    expect(after?.seoId).toBe(sharedSeoId);
  }, 60_000);

  // Встречная правка версии дописывает `seoId` между чтением скрипта и `deleteMany`: без замка строк версий
  // до чтения скрипт не увидел бы нового `Seo` и оставил бы его сиротой.
  it('скрипт дублей версий ждёт встречную запись seoId под замком строки и убирает её Seo', async () => {
    const version = await newVersion('dup-race');
    const seoId = await newSeo();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (pid: number) => void = () => undefined;
    const inside = new Promise<number>((resolve) => {
      entered = resolve;
    });
    const writer = prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        await tx.$queryRaw`SELECT id FROM "BookVersion" WHERE id = ${version.id} FOR NO KEY UPDATE`;
        await tx.bookVersion.update({ where: { id: version.id }, data: { seoId } });
        const [row] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
        entered(row.pid);
        await held;
      },
      { timeout: 30_000, maxWait: 10_000 },
    );

    let script: Promise<void> = Promise.resolve();
    let blocked = false;
    try {
      const holderPid = await inside;
      script = deleteVersionsWithSeo(prisma, [version.id]);
      const until = Date.now() + 10_000;
      while (!blocked && Date.now() < until) {
        const [row] = await prisma.$queryRaw<Array<{ n: number }>>`
          SELECT count(*)::int AS n FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid}::int = ANY(pg_blocking_pids(pid))`;
        blocked = row.n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } finally {
      release();
    }
    await Promise.all([writer, script]);

    expect(blocked).toBe(true);
    expect(await prisma.bookVersion.count({ where: { id: version.id } })).toBe(0);
    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  // `L-020`: транзакция скрипта несёт замок, чтение связей и удаление на каждую версию, плюс каскад глав —
  // дефолт Prisma (5 с / 2 с) на большой группе дал бы `P2028` и откат всей группы.
  it('скрипт дублей версий: одна транзакция на группу с явными границами', async () => {
    const version = await newVersion('dup-opts');
    const spy = jest.spyOn(prisma, '$transaction');

    await deleteVersionsWithSeo(prisma, [version.id]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toEqual({ timeout: 30_000, maxWait: 10_000 });
    spy.mockRestore();
  }, 60_000);

  it('страница: смена языка — 400, адрес не трогается', async () => {
    const page = await newPage('lang');

    await expect(
      pages.update(page.id, { language: Language.ru } as never, 'e2e-actor'),
    ).rejects.toBeInstanceOf(BadRequestException);
    const after = await prisma.page.findUnique({
      where: { id: page.id },
      select: { language: true, slug: true },
    });
    expect(after).toEqual({ language: Language.en, slug: `${prefix}-lang` });
  }, 60_000);

  // `T61`: остаток `LEGACY-400` — удаление персоны и целой книги, запись и чтение `Seo` версии.
  it('персона: удаление убирает Seo её переводов', async () => {
    const seoId = await newSeo();
    const person = await prisma.person.create({
      data: {
        canonicalName: `${prefix} person`,
        translations: {
          create: { language: Language.en, slug: `${prefix}-person`, displayName: 'P', seoId },
        },
      },
    });
    personIds.push(person.id);

    await persons.remove(person.id, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  it('книга: удаление целиком убирает Seo версий, унесённых каскадом', async () => {
    const seoId = await newSeo();
    const version = await newVersion('bookdel', seoId);

    await books.remove(version.bookId, 'e2e-actor');

    expect(await seoExists(seoId)).toBe(false);
  }, 60_000);

  /**
   * Встречная запись держит строку версии: привязала своё `Seo` и ещё не закоммитилась. Без замка
   * `upsertForVersion` читал `seoId = null`, заводил второе `Seo` и после коммита держателя
   * перезаписывал привязку — первое оставалось сиротой. С замком он ждёт и правит уже привязанное.
   */
  it('SEO версии: запись ждёт встречную привязку и не плодит второе Seo', async () => {
    const version = await newVersion('vupsert');
    const heldSeoId = await newSeo();

    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let locked: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let holderPid = 0;
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`UPDATE "BookVersion" SET "seoId" = ${heldSeoId} WHERE id = ${version.id}`;
        [{ pid: holderPid }] = await tx.$queryRaw<
          { pid: number }[]
        >`SELECT pg_backend_pid() AS pid`;
        locked();
        await gate;
      },
      { timeout: 60_000 },
    );
    // Отказ держателя до `locked()` всплывает сразу, а не таймаутом.
    await Promise.race([holding, holder]);
    const second = seo.upsertForVersion(version.id, { metaTitle: `${prefix} upsert` }).then(
      () => null,
      (error: unknown) => error,
    );
    let waitError: Error | null = null;
    try {
      const deadline = Date.now() + 30_000;
      for (;;) {
        // Ждёт именно тот, кого держит держатель: чужой ожидающий запрос параллельного e2e не в счёт.
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND ${holderPid} = ANY (pg_blocking_pids(pid))`;
        if (waiting > 0) break;
        if (Date.now() > deadline) throw new Error('запись SEO так и не встала на замок строки');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    } catch (error) {
      waitError = error instanceof Error ? error : new Error(String(error));
    } finally {
      release();
    }
    // Обе транзакции доводятся до конца и при отказе ожидания: `afterAll` не должен чистить под живой записью.
    await holder;
    const outcome = await second;
    if (waitError) throw waitError;
    expect(outcome).toBeNull();

    const after = await prisma.bookVersion.findUnique({
      where: { id: version.id },
      select: { seo: { select: { id: true, metaTitle: true } } },
    });
    expect(after?.seo).toEqual({ id: heldSeoId, metaTitle: `${prefix} upsert` });
    expect(await prisma.seo.count({ where: { metaTitle: `${prefix} upsert` } })).toBe(1);
  }, 60_000);

  // Публичное чтение отдаёт SEO только опубликованной версии (`LEGACY-400`, пачка `T80`).
  const publish = (id: string) =>
    prisma.bookVersion.update({ where: { id }, data: { status: 'published' } });

  it('SEO версии: черновик — 404 тем же текстом, после публикации — запись', async () => {
    const seoId = await newSeo();
    const version = await newVersion('vdraft', seoId);
    await expect(seo.getByVersion(version.id)).rejects.toThrow('BookVersion not found');

    await publish(version.id);

    await expect(seo.getByVersion(version.id)).resolves.toMatchObject({ id: seoId });
  }, 60_000);

  it('SEO версии: чтение после удаления версии — 404, а не удалённое Seo', async () => {
    const seoId = await newSeo();
    const version = await newVersion('vread', seoId);
    await publish(version.id);
    await expect(seo.getByVersion(version.id)).resolves.toMatchObject({ id: seoId });

    await versions.remove(version.id, 'e2e-actor');

    await expect(seo.getByVersion(version.id)).rejects.toThrow('BookVersion not found');
  }, 60_000);

  it('SEO версии: чтение после правки через форму версии отдаёт новое', async () => {
    const version = await newVersion('vedit');
    await publish(version.id);
    await seo.upsertForVersion(version.id, { metaTitle: `${prefix} before` });
    await expect(seo.getByVersion(version.id)).resolves.toMatchObject({
      metaTitle: `${prefix} before`,
    });

    await versions.update(version.id, { seoMetaTitle: `${prefix} after` });

    await expect(seo.getByVersion(version.id)).resolves.toMatchObject({
      metaTitle: `${prefix} after`,
    });
  }, 60_000);
});
