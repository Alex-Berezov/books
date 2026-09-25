/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookSummaryService } from '../src/modules/book-summary/book-summary.service';
import { createBookFixture } from './helpers/book-fixture';

describe('BookSummary e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let bookSummaries: BookSummaryService;
  let versionId: string;
  let userAccess: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    bookSummaries = moduleRef.get(BookSummaryService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await createBookFixture(prisma, `book-sum-${Date.now()}`);
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Version For Summary',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
        // LEGACY-267: схема больше не даёт `published` умолчанием — набор проверяет
        // анонимный доступ к саммари опубликованной версии, статус нужен явно.
        status: 'published',
      },
    });
    versionId = version.id;

    const email = `user_${Date.now()}@example.com`;
    const password = 'password123';
    const regUser = await request(http()).post('/auth/register').send({ email, password });
    if (regUser.status === 201) {
      userAccess = regUser.body.accessToken as string;
    } else if (regUser.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      userAccess = login.body.accessToken as string;
    }

    const adminEmail = 'admin@example.com';
    const regAdmin = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password });
    if (regAdmin.status === 201) {
      adminAccess = regAdmin.body.accessToken as string;
    } else if (regAdmin.status === 409) {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: adminEmail, password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    } else {
      throw new Error('Admin register failed');
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET returns null when no summary exists', async () => {
    const res = await request(http()).get(`/versions/${versionId}/summary`).expect(200);
    const isNull = res.body === null;
    const bodyObj = (res.body ?? {}) as Record<string, unknown>;
    const isEmptyObj =
      typeof res.body === 'object' && res.body !== null && Object.keys(bodyObj).length === 0;
    expect(isNull || isEmptyObj).toBe(true);
  });

  it('PUT requires auth and proper role', async () => {
    await request(http()).put(`/versions/${versionId}/summary`).send({ summary: 'S' }).expect(401);

    await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${userAccess}`)
      .send({ summary: 'S' })
      .expect(403);
  });

  it('Admin can upsert summary and GET returns data', async () => {
    const payload1 = {
      summary: 'Short summary',
      analysis: 'Some analysis',
      themes: 'theme1, theme2',
    };

    const put1 = await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload1)
      .expect(200);

    expect(put1.body.summary).toBe('Short summary');

    const get1 = await request(http()).get(`/versions/${versionId}/summary`).expect(200);
    expect(get1.body.summary).toBe('Short summary');

    const payload2 = { summary: 'Updated summary' };
    const put2 = await request(http())
      .put(`/versions/${versionId}/summary`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send(payload2)
      .expect(200);

    expect(put2.body.summary).toBe('Updated summary');
  });

  /**
   * `LEGACY-420`, посадка. Раньше `upsertForVersion` шёл «прочитал -> создал»
   * без транзакции и без уникального ключа: два параллельных сохранения одной
   * версии обе видели пустой `findFirst` и обе звали `create`, оставляя две
   * строки `BookSummary` на одну версию. Теперь чтение и запись идут
   * в транзакции под advisory-замком по версии: второй писатель ждёт коммита
   * первого. Уникального индекса нет (чистка старых дублей — за владельцем),
   * поэтому держит именно замок, и этот тест — его единственный сторож.
   *
   * ⚠️ Юнит этого не воспроизводит: мок `$transaction` исполняет тело
   * последовательно, двух одновременных транзакций там нет. Нужен живой Postgres.
   *
   * ⚠️ Сервис зовётся напрямую, не через HTTP (по образцу
   * `category-parent-race.e2e-spec.ts`): гвардов и вадилации-пайпа достаточно
   * джиттера, чтобы окно гонки почти всегда закрывалось само по себе — один
   * прогон через `supertest` эту гонку не ловит вовсе. Пар тоже несколько
   * (`ATTEMPTS`), по той же причине: единичная попытка расходится не каждый
   * раз, и красное было бы плавающим.
   */
  it('LEGACY-420: параллельные сохранения одной версии не плодят вторую строку', async () => {
    const ATTEMPTS = 20;

    for (let i = 0; i < ATTEMPTS; i += 1) {
      const book = await createBookFixture(prisma, `book-sum-race-${Date.now()}-${i}`);
      const raceVersion = await prisma.bookVersion.create({
        data: {
          bookId: book.id,
          language: 'en',
          title: `Version For Summary Race ${i}`,
          author: 'Author',
          description: 'Desc',
          coverImageUrl: 'https://example.com/c.jpg',
          type: 'text',
          isFree: true,
          status: 'published',
        },
      });

      const results = await Promise.allSettled([
        bookSummaries.upsertForVersion(raceVersion.id, { summary: 'Race summary A' }),
        bookSummaries.upsertForVersion(raceVersion.id, { summary: 'Race summary B' }),
      ]);
      for (const res of results) expect(res.status).toBe('fulfilled');

      const rows = await prisma.bookSummary.findMany({
        where: { bookVersionId: raceVersion.id },
      });
      expect(rows).toHaveLength(1);
    }
  }, 60_000);

  /**
   * 🔴 `LEGACY-420`, второй рубеж (пачка `T54`): уникальный индекс в базе. Писатель
   * мимо замка — вставка напрямую — получает `P2002`, а обычная правка через сервис
   * (код не менялся с `v1.0.128`, образ отката) идёт как прежде.
   */
  it('LEGACY-420: вторая сводка на ту же версию отвергается базой, правка через сервис идёт', async () => {
    const book = await createBookFixture(prisma, `book-sum-unique-${Date.now()}`);
    const v = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Version For Summary Unique',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });

    await bookSummaries.upsertForVersion(v.id, { summary: 'first' });
    await bookSummaries.upsertForVersion(v.id, { summary: 'second' });
    const rows = await prisma.bookSummary.findMany({ where: { bookVersionId: v.id } });
    expect(rows.map((r) => r.summary)).toEqual(['second']);

    await expect(
      prisma.bookSummary.create({ data: { bookVersionId: v.id, summary: 'bypass' } }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });
});
