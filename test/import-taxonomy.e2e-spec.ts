import request from 'supertest';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

type ImportResult = {
  imported: number;
  updated: number;
  errors: Array<{ key: string; message: string }>;
};

/**
 * `LEGACY-262`. Импорт — единственный путь, который создаёт термин вместе
 * с переводами и родителем, и после `LEGACY-131` он держится на интерактивной
 * транзакции. Юнит-спека (`src/modules/import/import.service.spec.ts`)
 * проверяет, **каким клиентом** сделана каждая запись, но откат проверить
 * не может: фейковый `$transaction` колбэк выполняет и ничего не откатывает.
 * То есть утверждение «обрыв не оставляет термина-призрака» на живой базе
 * не было проверено нигде, а оба маршрута импорта не имели ни одного e2e.
 *
 * Проверяется именно откат: конфликт слага перевода
 * (`CategoryTranslation.@@unique([language, slug])`) обязан не оставить
 * термина вовсе — не «термин без переводов», а пусто. Термин без переводов
 * занимает `key` и попадает в дерево, но не показывается ни на одной языковой
 * версии сайта: публичные маршруты отбирают по переводу нужного языка.
 */
describe('LEGACY-262 — импорт таксономий (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const stamp = Date.now();
  const prefix = `imp-${stamp}`;

  const parentKey = `${prefix}-parent`;
  const childKey = `${prefix}-child`;
  const ghostKey = `${prefix}-ghost`;
  const tagKey = `${prefix}-tag`;
  const tagGhostKey = `${prefix}-tag-ghost`;

  /** Слаги, занятые заранее: на них налетает импорт. */
  const takenCategorySlug = `${prefix}-taken-cat`;
  const takenCategorySlugRu = `${prefix}-taken-cat-ru`;
  const takenTagSlug = `${prefix}-taken-tag`;

  const post = (path: string, body: object) =>
    request(httpServerOf(app)).post(path).set('Authorization', `Bearer ${adminToken}`).send(body);

  /**
   * Тело ответа supertest объявлено как `any`, а `test/**` линтуется строго:
   * обращение к полю напрямую даёт `no-unsafe-member-access`. Приводим один
   * раз здесь, к форме `ImportResult` из `import.service.ts`.
   */
  const resultOf = (body: unknown): ImportResult => body as ImportResult;

  beforeAll(async () => {
    const adminEmail = 'admin-import-taxonomy@test.com';
    const adminPassword = 'password123';
    process.env.ADMIN_EMAILS = adminEmail;

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    prisma = app.get(PrismaService);
    await app.init();

    const reg = await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email: adminEmail, password: adminPassword });
    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(httpServerOf(app))
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = (login.body as { accessToken: string }).accessToken;
    }

    await prisma.category.create({
      data: {
        type: 'genre',
        name: 'Occupied',
        slug: takenCategorySlug,
        key: `${prefix}-occupied`,
        translations: {
          create: [
            { language: 'en', name: 'Occupied', slug: takenCategorySlug },
            { language: 'ru', name: 'Занято', slug: takenCategorySlugRu },
          ],
        },
      },
    });
    await prisma.tag.create({
      data: {
        name: 'Occupied tag',
        slug: takenTagSlug,
        key: `${prefix}-occupied-tag`,
        translations: { create: { language: 'en', name: 'Occupied tag', slug: takenTagSlug } },
      },
    });
  });

  afterAll(async () => {
    await prisma.category.deleteMany({ where: { key: { startsWith: prefix } } });
    await prisma.tag.deleteMany({ where: { key: { startsWith: prefix } } });
    await app?.close();
  });

  describe('POST /import/categories', () => {
    const batch = [
      {
        key: childKey,
        type: 'genre',
        parentKey,
        translations: {
          en: { name: 'Child', slug: `${prefix}-child-en` },
          ru: { name: 'Ребёнок', slug: `${prefix}-child-ru` },
        },
      },
      {
        key: parentKey,
        type: 'genre',
        translations: {
          en: { name: 'Parent', slug: `${prefix}-parent-en` },
          ru: { name: 'Родитель', slug: `${prefix}-parent-ru` },
        },
      },
    ];

    it('заводит термин с двумя переводами и родителем, хотя ребёнок стоит в файле первым', async () => {
      const res = await post('/import/categories', batch).expect(201);
      expect(res.body).toMatchObject({ imported: 2, updated: 0, errors: [] });

      const parent = await prisma.category.findUnique({ where: { key: parentKey } });
      const child = await prisma.category.findUnique({
        where: { key: childKey },
        include: { translations: true },
      });

      expect(parent).not.toBeNull();
      expect(child?.parentId).toBe(parent?.id);
      expect(child?.translations.map((t) => t.language).sort()).toEqual(['en', 'ru']);
    });

    it('повторный импорт того же файла обновляет, а не заводит второй термин', async () => {
      const res = await post('/import/categories', batch).expect(201);
      expect(res.body).toMatchObject({ imported: 0, updated: 2, errors: [] });

      const same = await prisma.category.findMany({ where: { key: childKey } });
      expect(same).toHaveLength(1);
    });

    // 🔴 Ветка обновления (`import.service.ts`, `existing`) отдельным кейсом:
    // до `LEGACY-257` там шли независимые `await`, и отказ на третьем языке
    // из пяти оставлял термин с переписанной базовой строкой и частью новых
    // переводов при счётчике `updated`, который не увеличился. Кейс выше
    // этого не ловит: он заводит новый `key`, то есть идёт веткой создания.
    it('конфликт при повторном импорте не переписывает ни базовую строку, ни уже прошедший перевод', async () => {
      const res = await post('/import/categories', [
        {
          key: childKey,
          type: 'genre',
          parentKey,
          translations: {
            en: { name: 'Child changed', slug: `${prefix}-child-en` },
            ru: { name: 'Ребёнок изменён', slug: takenCategorySlugRu },
          },
        },
        {
          key: parentKey,
          type: 'genre',
          translations: {
            en: { name: 'Parent', slug: `${prefix}-parent-en` },
            ru: { name: 'Родитель', slug: `${prefix}-parent-ru` },
          },
        },
      ]).expect(201);

      const result = resultOf(res.body);
      expect(result.errors.map((e) => e.key)).toEqual([childKey]);
      expect(result.updated).toBe(1);

      const child = await prisma.category.findUnique({
        where: { key: childKey },
        include: { translations: true },
      });
      const en = child?.translations.find((t) => t.language === 'en');

      expect(child?.name).toBe('Child');
      expect(en?.name).toBe('Child');
    });

    it('конфликт слага перевода не оставляет термина вовсе, а не термин без переводов', async () => {
      const res = await post('/import/categories', [
        {
          key: ghostKey,
          type: 'genre',
          translations: {
            en: { name: 'Ghost', slug: takenCategorySlug },
            ru: { name: 'Призрак', slug: `${prefix}-ghost-ru` },
          },
        },
      ]).expect(201);

      const result = resultOf(res.body);
      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].key).toBe(ghostKey);

      const ghost = await prisma.category.findUnique({ where: { key: ghostKey } });
      expect(ghost).toBeNull();
    });
  });

  describe('POST /import/tags', () => {
    const tagBatch = [
      {
        key: tagKey,
        name: 'Imported tag',
        slug: `${prefix}-tag-base`,
        translations: {
          en: { name: 'Imported tag', slug: `${prefix}-tag-en` },
          ru: { name: 'Импортированный тег', slug: `${prefix}-tag-ru` },
        },
      },
    ];

    it('заводит тег с двумя переводами', async () => {
      const res = await post('/import/tags', tagBatch).expect(201);
      expect(res.body).toMatchObject({ imported: 1, updated: 0, errors: [] });

      const tag = await prisma.tag.findUnique({
        where: { key: tagKey },
        include: { translations: true },
      });
      expect(tag?.translations.map((t) => t.language).sort()).toEqual(['en', 'ru']);
    });

    it('повторный импорт того же файла обновляет, а не заводит второй тег', async () => {
      const res = await post('/import/tags', tagBatch).expect(201);
      expect(res.body).toMatchObject({ imported: 0, updated: 1, errors: [] });
    });

    it('конфликт слага перевода не оставляет тега вовсе', async () => {
      const res = await post('/import/tags', [
        {
          key: tagGhostKey,
          name: 'Ghost tag',
          slug: `${prefix}-tag-ghost-base`,
          translations: {
            en: { name: 'Ghost tag', slug: takenTagSlug },
            ru: { name: 'Тег-призрак', slug: `${prefix}-tag-ghost-ru` },
          },
        },
      ]).expect(201);

      const result = resultOf(res.body);
      expect(result.imported).toBe(0);
      expect(result.errors).toHaveLength(1);

      const ghost = await prisma.tag.findUnique({ where: { key: tagGhostKey } });
      expect(ghost).toBeNull();
    });
  });
});
