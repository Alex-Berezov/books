/* eslint-disable @typescript-eslint/no-unsafe-member-access -- supertest отдаёт body как any, и обращение к полям ответа иначе не написать; тот же приём во всех e2e-спеках репозитория */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language } from '@prisma/client';
import { taxonomyFixture } from './helpers/taxonomy-null-cases';

/**
 * 🔴 `LEGACY-015`, пачка `T20`. Журнал административных действий на четырёх путях
 * физического удаления таксономии — проверка на **живой базе**.
 *
 * ⚠️ Юнит-спеки этих путей подменяют `AdminAuditService` целиком и поэтому в принципе
 * не могут поймать три вещи, каждая из которых уезжает на прод молча:
 *
 * 1. значение перечисления, которого нет в базе: `AdminAuditAction.CATEGORY_DELETED`
 *    компилируется от сгенерированного клиента, а падает на `INSERT`, если миграция
 *    `20260920190000_legacy_015_audit_taxonomy_deletes` не накатилась;
 * 2. состав `payload` после сериализации в `Json` — список переводов уезжает туда
 *    массивом объектов, и форма после круга через базу обязана совпасть с исходной;
 * 3. **что список умерших переводов в `payload` совпал с тем, что реально стёрлось.**
 *    `dying` собирается запросом до удаления, а сносит строки `deleteMany` — сойтись
 *    эти два списка обязаны на настоящем Postgres.
 *
 * Прецедент проверки — `admin-audit-content-deletes.e2e-spec.ts` из пачки `T19`.
 */
describe('LEGACY-015 T20: журнал удалений таксономии (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let actorUserId: string;
  const createdCategoryIds: string[] = [];
  const createdTagIds: string[] = [];
  // Переменная окружения восстанавливается в `afterAll`: прогон идёт в общем процессе
  // с соседними спеками, и оставленное значение меняет их поведение.
  const adminEmailsBefore = process.env.ADMIN_EMAILS;
  const prefix = `t20-${Date.now()}`;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  // 🔴 Оснастка общая, а не своя копия (`STYLE_GUIDE.md §1`): обязательные поля
  // термина уже менялись — так появился `key`, — и пятая рукописная копия этих
  // строк отвалилась бы на `.expect(201)` с видом «журнал сломан», пока четыре
  // набора на `taxonomyFixture` остались бы зелёными.
  const categories = taxonomyFixture(http, () => adminToken, 'categories', { type: 'genre' });
  const tags = taxonomyFixture(http, () => adminToken, 'tags');

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
    for (const id of createdCategoryIds) {
      await prisma.category.deleteMany({ where: { id } });
    }
    for (const id of createdTagIds) {
      await prisma.tag.deleteMany({ where: { id } });
    }
    await prisma.slugRedirect.deleteMany({ where: { oldSlug: { startsWith: prefix } } });
    if (adminEmailsBefore === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = adminEmailsBefore;
    }
    await app.close();
  });

  const createCategory = async (suffix: string): Promise<string> => {
    const slug = `${prefix}-cat-${suffix}`;
    const id = await categories.create(suffix, { slug, key: slug });
    createdCategoryIds.push(id);
    return id;
  };

  const createTag = async (suffix: string): Promise<string> => {
    const slug = `${prefix}-tag-${suffix}`;
    const id = await tags.create(suffix, { slug, key: slug });
    createdTagIds.push(id);
    return id;
  };

  it('DELETE /categories/:id пишет CATEGORY_DELETED со списком умерших переводов', async () => {
    const categoryId = await createCategory('doomed');

    for (const language of [Language.en, Language.ru]) {
      await categories.addTranslation(categoryId, language, `${prefix}-cat-doomed-${language}`);
    }

    await request(http())
      .delete(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'CATEGORY', targetId: categoryId, action: 'CATEGORY_DELETED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(actorUserId);

    const payload = events[0].payload as { slug: string; translations: unknown[] };
    expect(payload.slug).toBe(`${prefix}-cat-doomed`);
    // Список назван целиком и в том же составе, в каком переводы действительно стёрлись.
    expect(payload.translations).toHaveLength(2);
    expect(payload.translations).toEqual(
      expect.arrayContaining([
        { language: Language.en, slug: `${prefix}-cat-doomed-en` },
        { language: Language.ru, slug: `${prefix}-cat-doomed-ru` },
      ]),
    );

    // Строка действительно стёрта — событие описывает состоявшееся изменение.
    expect(await prisma.category.findUnique({ where: { id: categoryId } })).toBeNull();
    expect(await prisma.categoryTranslation.findMany({ where: { categoryId } })).toHaveLength(0);
  });

  it('DELETE /categories/:id/translations/:language пишет CATEGORY_TRANSLATION_DELETED на саму категорию', async () => {
    const categoryId = await createCategory('one-lang');

    await categories.addTranslation(categoryId, Language.en, `${prefix}-cat-one-lang-en`);

    await request(http())
      .delete(`/categories/${categoryId}/translations/en`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: {
        targetType: 'CATEGORY',
        targetId: categoryId,
        action: 'CATEGORY_TRANSLATION_DELETED',
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(actorUserId);
    // `targetId` — идентификатор категории, а не строки перевода: язык живёт в `payload`.
    expect(events[0].payload).toEqual({
      language: Language.en,
      slug: `${prefix}-cat-one-lang-en`,
    });
  });

  it('DELETE /tags/:id пишет TAG_DELETED со списком умерших переводов', async () => {
    const tagId = await createTag('doomed');

    for (const language of [Language.en, Language.ru]) {
      await tags.addTranslation(tagId, language, `${prefix}-tag-doomed-${language}`);
    }

    await request(http())
      .delete(`/tags/${tagId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'TAG', targetId: tagId, action: 'TAG_DELETED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(actorUserId);

    const payload = events[0].payload as { slug: string; translations: unknown[] };
    expect(payload.slug).toBe(`${prefix}-tag-doomed`);
    expect(payload.translations).toHaveLength(2);
    expect(payload.translations).toEqual(
      expect.arrayContaining([
        { language: Language.en, slug: `${prefix}-tag-doomed-en` },
        { language: Language.ru, slug: `${prefix}-tag-doomed-ru` },
      ]),
    );

    expect(await prisma.tag.findUnique({ where: { id: tagId } })).toBeNull();
    expect(await prisma.tagTranslation.findMany({ where: { tagId } })).toHaveLength(0);
  });

  it('DELETE /tags/:id/translations/:language пишет TAG_TRANSLATION_DELETED на сам тег', async () => {
    const tagId = await createTag('one-lang');

    await tags.addTranslation(tagId, Language.en, `${prefix}-tag-one-lang-en`);

    await request(http())
      .delete(`/tags/${tagId}/translations/en`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(204);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'TAG', targetId: tagId, action: 'TAG_TRANSLATION_DELETED' },
    });
    expect(events).toHaveLength(1);
    expect(events[0].actorUserId).toBe(actorUserId);
    expect(events[0].payload).toEqual({
      language: Language.en,
      slug: `${prefix}-tag-one-lang-en`,
    });
  });
});
