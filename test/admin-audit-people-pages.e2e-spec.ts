/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language } from '@prisma/client';

/**
 * 🔴 `LEGACY-015`, пачка `T21`. Журнал административных действий на людях и страницах —
 * проверка на **живой базе**. Этой пачкой пункт 1 записи закрывается целиком.
 *
 * ⚠️ Юнит-спеки этих путей ходят по стабам и поэтому в принципе не могут поймать
 * три вещи, каждая из которых уезжает на прод молча:
 *
 * 1. значение перечисления, которого нет в базе: `AdminAuditAction.PAGE_PUBLISHED`
 *    компилируется от сгенерированного клиента, а падает на `INSERT`, если миграция
 *    `20260920220000_legacy_015_audit_people_pages` не накатилась;
 * 2. состав `payload` после круга через `Json` — список адресов автора уезжает туда
 *    массивом объектов, и форма обязана вернуться той же;
 * 3. **идемпотентность видимости страницы.** `updateMany` с `status: { not: status }`
 *    в `where` отдаёт `count: 0` на повторном вызове — но это поведение настоящего
 *    Postgres, а не стаба: мок вернёт ровно то, что ему сказали вернуть.
 *
 * Прецедент проверки — `admin-audit-taxonomy-deletes.e2e-spec.ts` из пачки `T20`.
 */
describe('LEGACY-015 T21: журнал на людях и страницах (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let actorUserId: string;
  const createdAuthorIds: string[] = [];
  const createdPersonIds: string[] = [];
  const createdPageIds: string[] = [];
  // Переменная окружения восстанавливается в `afterAll`: прогон идёт в общем процессе
  // с соседними спеками, и оставленное значение меняет их поведение.
  const adminEmailsBefore = process.env.ADMIN_EMAILS;
  const prefix = `t21-${Date.now()}`;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }

    const admin = await prisma.user.findUniqueOrThrow({ where: { email } });
    actorUserId = admin.id;
  });

  afterAll(async () => {
    for (const id of createdAuthorIds) {
      await prisma.author.deleteMany({ where: { id } });
    }
    for (const id of createdPersonIds) {
      await prisma.person.deleteMany({ where: { id } });
    }
    for (const id of createdPageIds) {
      await prisma.page.deleteMany({ where: { id } });
    }
    if (adminEmailsBefore === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = adminEmailsBefore;
    }
    await app.close();
  });

  const createAuthor = async (suffix: string, languages: Language[]): Promise<string> => {
    const res = await request(http())
      .post('/admin/authors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        translations: languages.map((language) => ({
          language,
          name: `${prefix} author ${suffix} ${language}`,
          slug: `${prefix}-author-${suffix}-${language}`,
        })),
      })
      .expect(201);
    const id = res.body.id as string;
    createdAuthorIds.push(id);
    return id;
  };

  const createPerson = async (suffix: string): Promise<string> => {
    const res = await request(http())
      .post('/admin/contributors')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ displayName: `${prefix} person ${suffix}` })
      .expect(201);
    const id = res.body.id as string;
    createdPersonIds.push(id);
    return id;
  };

  const createPage = async (suffix: string): Promise<{ id: string; slug: string }> => {
    const slug = `${prefix}-page-${suffix}`;
    const res = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug, title: `Page ${suffix}`, type: 'generic', content: 'x', language: 'en' })
      .expect(201);
    const id = res.body.id as string;
    createdPageIds.push(id);
    return { id, slug };
  };

  const eventsFor = (targetType: string, targetId: string) =>
    prisma.adminAuditEvent.findMany({
      where: { targetType: targetType as never, targetId },
      orderBy: { createdAt: 'asc' },
    });

  it('DELETE /admin/authors/:id пишет AUTHOR_DELETED со списком умерших адресов', async () => {
    const authorId = await createAuthor('doomed', [Language.en, Language.ru]);

    await request(http())
      .delete(`/admin/authors/${authorId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await eventsFor('AUTHOR', authorId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('AUTHOR_DELETED');
    expect(events[0].actorUserId).toBe(actorUserId);

    // Список назван целиком и в том же составе, в каком переводы действительно стёрлись
    // каскадом `AuthorTranslation.author`.
    const payload = events[0].payload as { translations: unknown[] };
    expect(payload).toEqual({
      translations: [
        { language: Language.en, slug: `${prefix}-author-doomed-en` },
        { language: Language.ru, slug: `${prefix}-author-doomed-ru` },
      ],
    });

    expect(await prisma.author.findUnique({ where: { id: authorId } })).toBeNull();
    expect(await prisma.authorTranslation.findMany({ where: { authorId } })).toHaveLength(0);
  });

  it('DELETE /admin/contributors/:id пишет PERSON_DELETED без payload', async () => {
    const personId = await createPerson('doomed');

    await request(http())
      .delete(`/admin/contributors/${personId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const events = await eventsFor('PERSON', personId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('PERSON_DELETED');
    expect(events[0].actorUserId).toBe(actorUserId);
    // 🔴 `payload` пуст намеренно: у персоны сверх идентификатора есть только имя,
    // а имён в журнале быть не должно. Проверяется явно, потому что дописать его
    // туда — одна строка, и никакая другая спека этого не увидит.
    expect(events[0].payload).toBeNull();

    expect(await prisma.person.findUnique({ where: { id: personId } })).toBeNull();
  });

  it('DELETE /admin/:lang/pages/:id пишет PAGE_DELETED с умершим адресом', async () => {
    const { id: pageId, slug } = await createPage('doomed');

    await request(http())
      .delete(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await eventsFor('PAGE', pageId);
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe('PAGE_DELETED');
    expect(events[0].actorUserId).toBe(actorUserId);
    expect(events[0].payload).toEqual({ language: Language.en, slug });

    expect(await prisma.page.findUnique({ where: { id: pageId } })).toBeNull();
  });

  it('publish и unpublish пишут обе стороны пары, в порядке нажатий', async () => {
    const { id: pageId } = await createPage('visible');

    await request(http())
      .patch(`/admin/en/pages/${pageId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await request(http())
      .patch(`/admin/en/pages/${pageId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const events = await eventsFor('PAGE', pageId);
    expect(events.map((e) => e.action)).toEqual(['PAGE_PUBLISHED', 'PAGE_UNPUBLISHED']);
    expect(events.every((e) => e.actorUserId === actorUserId)).toBe(true);
    // `payload` нет ни у одной стороны: строка жива, язык и слаг читаются из неё самой.
    expect(events.every((e) => e.payload === null)).toBe(true);
  });

  /**
   * 🔴 Третий вход в смену видимости — общая форма редактирования. Поле `status` есть
   * у `UpdatePageDto`, и до пачки `T21` этот путь менял видимость молча. Собственная
   * админка им не пользуется (`PagePublishPanel` ходит в выделенные ручки), но для
   * любого держателя админского токена он открыт.
   */
  it('PATCH admin/:lang/pages/:id со status пишет те же события видимости', async () => {
    const { id: pageId } = await createPage('via-form');

    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'published' })
      .expect(200);

    // Правка без поля `status` события не пишет — иначе любое редактирование
    // выглядело бы публикацией.
    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ title: 'Renamed' })
      .expect(200);

    // Тот же статус второй раз — состояние не изменилось, события нет.
    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'published' })
      .expect(200);

    const hidden = await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ status: 'draft' })
      .expect(200);

    // Контракт ручки не изменился: тело несёт новый статус.
    expect(hidden.body.status).toBe('draft');

    const events = await eventsFor('PAGE', pageId);
    expect(events.map((e) => e.action)).toEqual(['PAGE_PUBLISHED', 'PAGE_UNPUBLISHED']);
    expect(events.every((e) => e.actorUserId === actorUserId)).toBe(true);
  });

  /**
   * 🔴 Инвариант «событие равно изменению состояния» — на настоящей базе.
   *
   * Условие `status: { not: status }` живёт в `where` запроса, а не в коде сервиса,
   * поэтому ответ на вопрос «изменилось ли что-нибудь» даёт Postgres. Стаб здесь
   * бесполезен: он вернёт тот `count`, который ему велели вернуть.
   */
  it('повторная публикация не пишет второго события, а ручка отвечает как прежде', async () => {
    const { id: pageId } = await createPage('repeat');

    await request(http())
      .patch(`/admin/en/pages/${pageId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const second = await request(http())
      .patch(`/admin/en/pages/${pageId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Контракт ручки не изменился: тот же 200 и та же страница в теле.
    expect(second.body.id).toBe(pageId);
    expect(second.body.status).toBe('published');

    const events = await eventsFor('PAGE', pageId);
    expect(events.map((e) => e.action)).toEqual(['PAGE_PUBLISHED']);
  });
});
