import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

/**
 * Сторож запрета «книга создаётся только из утверждённого клиренса» (`LEGACY-039`).
 *
 * Запрет держится на контроллере и сервисе, а не на схеме: запись в `Book` через Prisma проходит
 * всегда, и фикстуры этим пользуются (`test/helpers/book-fixture.ts`).
 *
 * Что здесь **не** новое: код и текст отказа `POST /books` уже проверяют `test/book.e2e-spec.ts`
 * (e2e, тело с валидным слагом) и `src/modules/book/book.controller.spec.ts` (юнит). Новое —
 * две вещи, которых не было ни в одном наборе:
 *
 * 1. **уровень данных** у отказа: после 400 в базе не прибавилось ни одной книги. Ровно этого
 *    и не хватало записи — «ни один e2e не подтверждает запрет на уровне данных»;
 * 2. отказ второго входа — `create-book` по **неутверждённому** клиренсу.
 *
 * Третья половина запрета — статический инвариант «в `test/` книгу заводит ровно один файл» —
 * живёт парой к этому набору в `src/devops/book-fixture-single-point.spec.ts`. Она вынесена туда
 * не по вкусу: гейт `e2e` включается только по правкам контроллеров, а нарушают инвариант
 * тест-онли диффы — здесь он молчал бы до job `e2e` в CI, то есть уже после коммита. Один файл
 * без другого закрывает запись наполовину: этот проверяет, что продуктовый путь закрыт, тот —
 * что фикстуры не растащили обход обратно.
 *
 * Санкционированный путь целиком (intake → status → review-import → materialize → approve →
 * create-book) проверяют `rights-lawyer-workflow`, `rights-clearance-to-geo-block`,
 * `rights-actions` и `rights-recheck` — здесь он не дублируется.
 */
describe('Book creation ban (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let adminEmailsBefore: string | undefined;

  const http = () => httpServerOf(app);

  beforeAll(async () => {
    const adminEmail = 'admin-book-ban@test.com';
    const adminPassword = 'password123';
    // Значение возвращается в `afterAll`: воркер жив дольше набора (`maxWorkers: 2`), и
    // оставленный список админов достаётся следующему набору, который его не задавал.
    adminEmailsBefore = process.env.ADMIN_EMAILS;
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

    const registration = await request(http())
      .post('/auth/register')
      .send({ email: adminEmail, password: adminPassword });

    if (registration.status === 201) {
      adminToken = (registration.body as { accessToken: string }).accessToken;
    } else if (registration.status === 409) {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = (login.body as { accessToken: string }).accessToken;
    } else {
      throw new Error(`Unexpected admin register status: ${registration.status}`);
    }
  });

  afterAll(async () => {
    await app.close();
    if (adminEmailsBefore === undefined) {
      delete process.env.ADMIN_EMAILS;
    } else {
      process.env.ADMIN_EMAILS = adminEmailsBefore;
    }
  });

  describe('прямое создание книги', () => {
    it('POST /books отбивается 400 и не создаёт ни одной книги', async () => {
      const before = await prisma.book.count();

      const response = await request(http())
        .post('/books')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({})
        .expect(400);

      expect(response.body).toMatchObject({
        message: 'Books must be created from an approved rights intake',
        details: 'Use POST /admin/rights/intakes/:id/create-book endpoint instead',
      });

      // Уровень данных: отказ обязан быть отказом, а не 400 поверх уже созданной строки.
      expect(await prisma.book.count()).toBe(before);
    });
  });

  describe('создание книги по неутверждённому клиренсу', () => {
    it('create-book на интейке в статусе DRAFT отбивается и книги не появляется', async () => {
      const slug = `ban-draft-intake-${Date.now()}`;

      const intake = await request(http())
        .post('/admin/rights/intakes')
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          candidateTitle: 'Book creation ban e2e',
          candidateAuthor: 'Test Author',
          targetLanguages: ['en'],
          targetCountryCodes: ['US'],
          plannedContentTypes: ['text'],
        })
        .expect(201);

      const intakeId = (intake.body as { id: string }).id;

      try {
        const refused = await request(http())
          .post(`/admin/rights/intakes/${intakeId}/create-book`)
          .set('Authorization', `Bearer ${adminToken}`)
          .send({
            slug,
            versions: [
              {
                language: 'en',
                title: 'Book creation ban e2e',
                author: 'Test Author',
                type: 'text',
                isFree: true,
              },
            ],
          })
          .expect(400);

        expect(refused.body).toMatchObject({
          code: 'BOOK_CREATION_INTAKE_NOT_APPROVED',
          details: { workflowStatus: 'DRAFT', expected: 'APPROVED' },
        });

        expect(await prisma.book.findUnique({ where: { slug } })).toBeNull();
      } finally {
        await prisma.rightsIntake.deleteMany({ where: { id: intakeId } });
      }
    });
  });
});
