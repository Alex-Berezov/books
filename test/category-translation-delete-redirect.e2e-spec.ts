import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language } from '@prisma/client';

/**
 * `LEGACY-085`. Политика владельца от 15.09.2026: удаление перевода категории уводит
 * на родительский термин там, где родитель есть, и оставляет 404 там, где его нет.
 *
 * 🔴 Этот набор существует потому, что **два случая ниже юнитами непроверяемы**: в спеке
 * сервиса слой данных замокан целиком, а ровно те два условия, которые ревью нашло
 * пропущенными, зависят от настоящего состояния базы — занят ли слаг чьим-то базовым
 * `Category.slug` и что осталось в истории после второго удаления. Юниты проверяют,
 * что ветка выбрана; здесь — что она выбрана по правде.
 *
 * Оба случая пришли из отчёта ревью 15.09.2026, форма — решение арбитра того же дня
 * (вариант D, `decisions-log.md`).
 */

type IdBody = { id: string };
type TokenBody = { accessToken: string };

describe('LEGACY-085: удаление перевода категории и история слагов (e2e)', () => {
  let app: INestApplication;
  let db: PrismaService;
  let admin: string;
  const created: string[] = [];

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  let counter = 0;
  const uniq = (prefix: string): string => `${prefix}-${Date.now()}-${counter++}`;

  /** Категория с переводом на `ru`. Базовый слаг задаётся отдельно от слага перевода. */
  const createCategory = async (
    baseSlug: string,
    ruSlug: string,
    parentId?: string,
  ): Promise<string> => {
    const res = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${admin}`)
      .send({ type: 'genre', name: baseSlug, slug: baseSlug, key: baseSlug, parentId })
      .expect(201);
    const id = (res.body as IdBody).id;
    created.push(id);

    await request(http())
      .post(`/categories/${id}/translations`)
      .set('Authorization', `Bearer ${admin}`)
      .send({ language: Language.ru, name: ruSlug, slug: ruSlug })
      .expect(201);

    return id;
  };

  const deleteRuTranslation = async (id: string): Promise<void> => {
    await request(http())
      .delete(`/categories/${id}/translations/${Language.ru}`)
      .set('Authorization', `Bearer ${admin}`)
      .expect(204);
  };

  /** Куда ведёт история для `oldSlug`, или `null`, если записи нет. */
  const redirectsTo = async (oldSlug: string): Promise<string | null> => {
    const row = await db.slugRedirect.findFirst({
      where: { entityType: 'category', language: Language.ru, oldSlug },
    });
    return row?.newSlug ?? null;
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    db = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      admin = (reg.body as TokenBody).accessToken;
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      admin = (login.body as TokenBody).accessToken;
    }
  });

  afterAll(async () => {
    for (const id of [...created].reverse()) {
      await db.categoryTranslation.deleteMany({ where: { categoryId: id } });
      await db.category.deleteMany({ where: { id } });
    }
    await app?.close();
  });

  it('обычный случай: запись ведёт на перевод родителя', async () => {
    const parentRu = uniq('l085-roditel');
    const parentId = await createCategory(uniq('l085-parent'), parentRu);

    const childRu = uniq('l085-rebenok');
    const childId = await createCategory(uniq('l085-child'), childRu, parentId);

    await deleteRuTranslation(childId);

    expect(await redirectsTo(childRu)).toBe(parentRu);
  });

  /**
   * Случай 1 из ревью. Слаг перевода совпал с базовым `Category.slug` — именно так
   * заводит термины сид, и для `en` это норма. Публичный резолв в такой ситуации
   * не отвечает 404: он падает на поиск по базовому слагу и отдаёт 200 с пустым
   * переводом, поэтому страница уходит в 404 **до** обращения к истории слагов,
   * и 308 не выдаётся никогда. Запись здесь была бы строкой, которой ничто
   * не соответствует.
   */
  it('слаг, занятый базовым Category.slug, записи не получает', async () => {
    const parentId = await createCategory(uniq('l085-p2'), uniq('l085-p2-ru'));

    // Базовый слаг и слаг перевода — одна и та же строка.
    const sameSlug = uniq('l085-same');
    const childId = await createCategory(sameSlug, sameSlug, parentId);

    await deleteRuTranslation(childId);

    expect(await redirectsTo(sameSlug)).toBeNull();
  });

  /**
   * Случай 2 из ревью. Удалили перевод ребёнка — записан переход на родителя. Затем
   * удалили перевод самого родителя: своего родителя у него нет, преемника не будет.
   * Без уборки прежний адрес ребёнка отвечал бы 308 на адрес, которого больше нет, —
   * то есть 308 в 404, а он из индекса не отзывается. Ровно за это арбитр отклонил
   * вариант D3, и правка не вправе вносить его сама.
   */
  it('после исчезновения цели запись ребёнка снимается, а не ведёт в никуда', async () => {
    const parentRu = uniq('l085-p3-ru');
    const parentId = await createCategory(uniq('l085-p3'), parentRu);

    const childRu = uniq('l085-c3-ru');
    const childId = await createCategory(uniq('l085-c3'), childRu, parentId);

    await deleteRuTranslation(childId);
    expect(await redirectsTo(childRu)).toBe(parentRu);

    await deleteRuTranslation(parentId);

    expect(await redirectsTo(childRu)).toBeNull();
  });
});
