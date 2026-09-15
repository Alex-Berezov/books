import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { Language, BookType } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { markBookRightsFreshForTests } from './helpers/rights-fresh';
import { taxonomyFixture, uniqueMark, readSlugRedirect } from './helpers/taxonomy-null-cases';

/**
 * `LEGACY-395`. `remove()` в `tags`, `pages`, `book`, `book-version` не убирал историю
 * `SlugRedirect`, ведущую на умерший слаг сущности — старый 308 продолжал висеть на
 * адресе, который стал 404. Правка добавила уборку во все четыре плюс общий
 * `SlugRedirectService.cleanupDeadRedirects`.
 *
 * 🔴 Почему этот набор нужен отдельно от юнитов. Решение арбитра 15.09.2026
 * (`decisions-log.md`, вопрос про `LEGACY-395`): у трёх из четырёх сервисов живость
 * адреса решает не форма запроса, а поведение самой базы. `book.service.ts` спрашивает
 * живость **после** `book.delete`, и ответ верен только если реальный каскад
 * `onDelete: Cascade` (`prisma/schema.prisma`) уже снял версии удалённой книги внутри
 * той же транзакции. `tags.service.ts` отбирает вложенным фильтром связи
 * `tag: { isVisible: true }` — Prisma собирает JOIN, которого мок не воспроизводит.
 * `book-version.service.ts` решает живость по версии **чужой книги в чужом языке** —
 * то есть по `@@unique([language, slug])`, которое ограничивает лишь пару (язык, слаг),
 * а не слаг вообще. Ревью `/qa` нашло на этом самом заходе два реальных бага именно
 * в этой части (живость решалась по языкам записи, а не по языконезависимому
 * фоллбэку `getOverview`) — юниты с замоканной Prisma их не поймали, поймало чтение
 * кода. Здесь те же сценарии проверяются на настоящей транзакции и настоящей базе.
 *
 * Объём — по одному кейсу «адрес умер → снят» и «адрес жив у чужой сущности → на
 * месте» на каждую ветку живости, без прогонки всей матрицы языков (решение арбитра).
 */
describe('LEGACY-395: remove() чистит мёртвую историю слагов (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;
  let admin: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;
  const tags = taxonomyFixture(http, () => admin, 'tags');

  /** Слаги фикстур книг — по ним `cleanupBookWithRights` найдёт цепочку прав даже
   *  после того, как сама посадка переименовала `Book.slug`. */
  const bookFixtureSlugs: string[] = [];

  const newBook = async (fixtureSlug: string): Promise<string> => {
    const created = await createBookWithRights(prisma, fixtureSlug);
    bookFixtureSlugs.push(fixtureSlug);
    return created.book.id;
  };

  const createVersion = async (
    bookId: string,
    language: Language,
    slug: string,
  ): Promise<string> => {
    const res = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${admin}`)
      .send({
        language,
        title: 'Test title',
        author: 'Test author',
        description: 'Test description',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
        slug,
      })
      .expect(201);
    return (res.body as { id: string }).id;
  };

  const publishVersion = async (bookId: string, versionId: string): Promise<void> => {
    await markBookRightsFreshForTests(prisma, bookId, rightsContentHashService);
    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(200);
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    rightsContentHashService = moduleRef.get(RightsContentHashService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      admin = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      admin = (login.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    for (const slug of bookFixtureSlugs) {
      await cleanupBookWithRights(prisma, slug);
    }
    await app.close();
  });

  describe('tags', () => {
    it('слаг перевода никем не занят — запись снята', async () => {
      const tagId = await tags.create(uniqueMark('l395-tag1'));
      const oldSlug = uniqueMark('l395-tag1-tr-old');
      await tags.addTranslation(tagId, Language.ru, oldSlug);
      const newSlug = uniqueMark('l395-tag1-tr-new');
      await tags.renameTranslation(tagId, Language.ru, newSlug);
      expect(await readSlugRedirect(prisma, 'tag', Language.ru, oldSlug)).toBe(newSlug);

      await tags.drop(tagId);

      expect(await readSlugRedirect(prisma, 'tag', Language.ru, oldSlug)).toBeNull();
    });

    /**
     * Находка ревью этого же захода, починенная в нём же: `versionsByTagLangSlug`
     * (публичный резолв) считает базовый слаг живым только у **видимого** тега.
     * Без `isVisible: true` в запросе уборки скрытый тег ошибочно объявлял бы
     * адрес живым, и запись осталась бы висеть 308-м на публично уже мёртвый адрес.
     */
    it('скрытый тег с тем же базовым слагом адрес не оживляет — запись всё равно снимается', async () => {
      const hiddenSlug = uniqueMark('l395-tag-hidden');
      await request(http())
        .post('/tags')
        .set('Authorization', `Bearer ${admin}`)
        .send({ name: 'Hidden', slug: hiddenSlug, key: hiddenSlug, isVisible: false })
        .expect(201);

      const tagId = await tags.create(uniqueMark('l395-tag2'));
      const oldSlug = uniqueMark('l395-tag2-tr-old');
      await tags.addTranslation(tagId, Language.ru, oldSlug);
      await tags.renameTranslation(tagId, Language.ru, hiddenSlug);
      expect(await readSlugRedirect(prisma, 'tag', Language.ru, oldSlug)).toBe(hiddenSlug);

      await tags.drop(tagId);

      expect(await readSlugRedirect(prisma, 'tag', Language.ru, oldSlug)).toBeNull();
    });
  });

  describe('pages', () => {
    it('у страницы нет ни родителя, ни базового слага — адрес мёртв безусловно, запись снята', async () => {
      const oldSlug = uniqueMark('l395-page-old');
      const newSlug = uniqueMark('l395-page-new');

      const created = await request(http())
        .post('/admin/en/pages')
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: oldSlug, title: 'Page title', type: 'generic', content: 'Body' })
        .expect(201);
      const pageId = (created.body as { id: string }).id;

      await request(http())
        .patch(`/admin/en/pages/${pageId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: newSlug })
        .expect(200);
      expect(await readSlugRedirect(prisma, 'page', Language.en, oldSlug)).toBe(newSlug);

      await request(http())
        .delete(`/admin/en/pages/${pageId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);

      expect(await readSlugRedirect(prisma, 'page', Language.en, oldSlug)).toBeNull();
    });
  });

  describe('books', () => {
    /**
     * 🔴 Находка второго круга ревью: своя же опубликованная версия удаляемой
     * книги держит **тот же** слаг, что и переименованный базовый `Book.slug`
     * (совпадение обычное — версия могла унаследовать слаг при переносе).
     * `book.delete` кладёт её каскадом (`onDelete: Cascade`,
     * `prisma/schema.prisma:70`) внутри той же транзакции, и только потом
     * `isBookSlugLive` спрашивает базу — то есть щупается именно порядок
     * «сперва каскад, потом проверка», а не только форма запроса.
     */
    it('слаг мёртв — запись снята во всех языках, включая случай, когда своя же версия каскадом ушла первой', async () => {
      const fixtureSlug = uniqueMark('l395-book1');
      const bookId = await newBook(fixtureSlug);
      const deadSlug = uniqueMark('l395-book1-dead');

      // Своя же версия держит тот же слаг, на который переименован базовый —
      // после удаления книги каскад обязан снести её раньше, чем пойдёт
      // запрос живости, иначе он найдёт эту же строку и ошибочно сочтёт
      // адрес живым.
      const ownVersionId = await createVersion(bookId, Language.en, deadSlug);
      await publishVersion(bookId, ownVersionId);

      await request(http())
        .patch(`/books/${bookId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: deadSlug })
        .expect(200);
      for (const language of [Language.en, Language.ru] as const) {
        expect(await readSlugRedirect(prisma, 'book', language, fixtureSlug)).toBe(deadSlug);
      }

      await request(http())
        .delete(`/books/${bookId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      for (const language of [Language.en, Language.ru] as const) {
        expect(await readSlugRedirect(prisma, 'book', language, fixtureSlug)).toBeNull();
      }
    });

    /**
     * Ровно тот баг, что нашли ревьюеры на этом заходе (починен здесь же).
     * `getOverview` при промахе по паре (слаг, язык) ищет версию по слагу **без
     * учёта языка запроса** — значит живая опубликованная версия чужой книги
     * в ОДНОМ языке держит адрес живым сразу во ВСЕХ пяти, а не только в своём.
     * Проверяем ровно тот язык, где живой версии нет: если бы живость решалась
     * по языкам записи (прежняя, ошибочная редакция), запись здесь была бы снята.
     */
    it('слаг жив чужой опубликованной версией в другом языке — запись не снимается ни в одном языке', async () => {
      const victimFixtureSlug = uniqueMark('l395-book2-victim');
      const victimId = await newBook(victimFixtureSlug);
      const deadSlug = uniqueMark('l395-book2-dead');

      await request(http())
        .patch(`/books/${victimId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: deadSlug })
        .expect(200);
      expect(await readSlugRedirect(prisma, 'book', Language.ru, victimFixtureSlug)).toBe(deadSlug);

      const otherFixtureSlug = uniqueMark('l395-book2-other');
      const otherId = await newBook(otherFixtureSlug);
      const otherVersionId = await createVersion(otherId, Language.en, deadSlug);
      await publishVersion(otherId, otherVersionId);

      await request(http())
        .delete(`/books/${victimId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(200);

      expect(await readSlugRedirect(prisma, 'book', Language.ru, victimFixtureSlug)).toBe(deadSlug);
    });
  });

  describe('book versions', () => {
    it('слаг версии мёртв — запись снята', async () => {
      const fixtureSlug = uniqueMark('l395-bv1');
      const bookId = await newBook(fixtureSlug);
      const oldSlug = uniqueMark('l395-bv1-old');
      const newSlug = uniqueMark('l395-bv1-new');
      const versionId = await createVersion(bookId, Language.ru, oldSlug);
      await publishVersion(bookId, versionId);

      await request(http())
        .patch(`/versions/${versionId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: newSlug })
        .expect(200);
      expect(await readSlugRedirect(prisma, 'book', Language.ru, oldSlug)).toBe(newSlug);

      await request(http())
        .delete(`/versions/${versionId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);

      expect(await readSlugRedirect(prisma, 'book', Language.ru, oldSlug)).toBeNull();
    });

    /**
     * Тот же класс бага, что и у книги, найденный и починенный этим же заходом:
     * первая редакция спрашивала только `Book.slug`, не другую живую версию.
     * `@@unique([language, slug])` не мешает версии ДРУГОЙ книги в ДРУГОМ языке
     * держать тот же слаг — `getOverview` находит её без фильтра по языку
     * и оживляет адрес и в языке удалённой версии тоже.
     */
    it('слаг версии жив чужой опубликованной версией в другом языке — запись не снимается', async () => {
      const victimFixtureSlug = uniqueMark('l395-bv2-victim');
      const victimBookId = await newBook(victimFixtureSlug);
      const oldSlug = uniqueMark('l395-bv2-old');
      const deadSlug = uniqueMark('l395-bv2-dead');
      const victimVersionId = await createVersion(victimBookId, Language.ru, oldSlug);
      await publishVersion(victimBookId, victimVersionId);

      await request(http())
        .patch(`/versions/${victimVersionId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: deadSlug })
        .expect(200);
      expect(await readSlugRedirect(prisma, 'book', Language.ru, oldSlug)).toBe(deadSlug);

      const otherFixtureSlug = uniqueMark('l395-bv2-other');
      const otherBookId = await newBook(otherFixtureSlug);
      const otherVersionId = await createVersion(otherBookId, Language.en, deadSlug);
      await publishVersion(otherBookId, otherVersionId);

      await request(http())
        .delete(`/versions/${victimVersionId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);

      expect(await readSlugRedirect(prisma, 'book', Language.ru, oldSlug)).toBe(deadSlug);
    });

    /**
     * Находка второго круга ревью, починенная в нём же: предикат живости
     * бинарный и языконезависимый (см. докблок `remove()` в
     * `book-version.service.ts`), значит и уборка при мёртвом слаге обязана
     * идти по всем пяти языкам, а не только по языку удалённой версии. Иначе
     * запись, оставшаяся от смены слага СОВСЕМ ДРУГОЙ версии в другом языке
     * на тот же теперь-мёртвый слаг, продолжает висеть 308-м на 404.
     */
    it('смерть слага снимает записи во всех языках, а не только в языке удалённой версии', async () => {
      const sharedSlug = uniqueMark('l395-bv3-shared');

      // Версия A (fr) переезжает на общий слаг — запись fr: oldSlug→sharedSlug
      // заведена, и сама A теперь на нём сидит.
      const oldSlug = uniqueMark('l395-bv3-old');
      const bookAId = await newBook(uniqueMark('l395-bv3-a'));
      const versionAId = await createVersion(bookAId, Language.fr, oldSlug);
      await publishVersion(bookAId, versionAId);
      await request(http())
        .patch(`/versions/${versionAId}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ slug: sharedSlug })
        .expect(200);
      expect(await readSlugRedirect(prisma, 'book', Language.fr, oldSlug)).toBe(sharedSlug);

      // Версия B (en) держит тот же слаг параллельно — разным языкам
      // `@@unique([language, slug])` делить слаг не мешает.
      const bookBId = await newBook(uniqueMark('l395-bv3-b'));
      const versionBId = await createVersion(bookBId, Language.en, sharedSlug);
      await publishVersion(bookBId, versionBId);

      // A снята — слаг пережил это: его по-прежнему держит B (en, любой язык
      // не важен для языконезависимого фоллбэка). Запись обязана уцелеть.
      await request(http())
        .delete(`/versions/${versionAId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);
      expect(await readSlugRedirect(prisma, 'book', Language.fr, oldSlug)).toBe(sharedSlug);

      // Теперь снята и B — больше никто слаг не держит нигде. Запись,
      // оставленная СОВСЕМ ДРУГОЙ (уже удалённой) версией A в другом языке,
      // обязана сняться этим же вызовом, хотя удаляли en-версию, а запись — fr.
      await request(http())
        .delete(`/versions/${versionBId}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(204);

      expect(await readSlugRedirect(prisma, 'book', Language.fr, oldSlug)).toBeNull();
    });
  });
});
