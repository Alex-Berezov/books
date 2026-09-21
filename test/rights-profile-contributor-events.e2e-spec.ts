import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';

/**
 * `LEGACY-037` — журнал связей участников профиля прав читается через API.
 *
 * Сценарий записи: связь участника с профилем удаляется физически, взамен каждая привязка
 * и отвязка пишет неудаляемое событие. До этой посадки события писались и не читались нигде —
 * узнать, кого и когда отвязали, можно было только прямым доступом к БД.
 *
 * Тест идёт сквозным путём: HTTP-привязка → HTTP-отвязка → `GET /admin/rights/profiles/:id`.
 * Мок здесь не годится: проверяется ровно то, что событие переживает удаление своей связи.
 *
 * Требует живой БД — локально `yarn test:e2e`, в CI job «Tests & Quality Checks».
 */

interface ContributorEventSnapshot {
  canonicalName: string | null;
  birthYear: number | null;
  deathYear: number | null;
  nationalityCountryCode: string | null;
  notesRu: string | null;
  linkedAt: string | null;
}

interface ContributorEvent {
  id: string;
  eventType: string;
  rightsProfileContributorId: string;
  personId: string | null;
  role: string | null;
  displayName: string | null;
  creditedName: string | null;
  snapshot: ContributorEventSnapshot | null;
  createdByUserId: string | null;
  createdAt: string;
}

interface ProfileDetailBody {
  contributors: Array<{ id: string }>;
  contributorEvents: ContributorEvent[];
}

describe('Rights profile contributor events (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let bookWithRights: Awaited<ReturnType<typeof createBookWithRights>>;
  let sourceEditionId: string;
  let personId: string;
  let adminUserId: string;

  const slug = `profile-contributor-events-${Date.now()}`;
  const createdPersonIds: string[] = [];
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const profileDetail = async (): Promise<ProfileDetailBody> => {
    const response = await request(http())
      .get(`/admin/rights/profiles/${bookWithRights.profile.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    return response.body as ProfileDetailBody;
  };

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin-profile-contributor-events@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const email = 'admin-profile-contributor-events@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    const tokenOf = (body: unknown): string => (body as { accessToken: string }).accessToken;
    if (reg.status === 201) {
      adminToken = tokenOf(reg.body);
    } else {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = tokenOf(login.body);
    }

    bookWithRights = await createBookWithRights(prisma, slug);

    const sourceEdition = await prisma.sourceEdition.findUniqueOrThrow({
      where: { rightsProfileId: bookWithRights.profile.id },
      select: { id: true },
    });
    sourceEditionId = sourceEdition.id;

    const person = await request(http())
      .post('/admin/persons')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        type: 'NATURAL_PERSON',
        canonicalName: `Переводчик ${Date.now()}`,
        birthYear: 1901,
        deathYear: 1975,
        nationalityCountryCode: 'RU',
      })
      .expect(201);
    personId = (person.body as { id: string }).id;
    createdPersonIds.push(personId);

    // Точный id администратора: без него проверка «кто отвязал» принимала бы любую строку,
    // а подмена актёра на `personId` (обе величины — uuid) прошла бы мимо теста (`LEGACY-015`).
    const me = await request(http())
      .get('/users/me')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    adminUserId = (me.body as { id: string }).id;
  });

  // 🔴 Каждый шаг уборки стоит под своей переменной, а фильтр по персонам — список, а не
  // одиночный id. Отказ в `beforeAll` (например `POST /admin/persons` вернул не 201) оставляет
  // `personId` неопределённым, `afterAll` выполняется всё равно, и Prisma выбрасывает
  // `undefined`-поля фильтра: `deleteMany({ where: { id: undefined } })` вырождается
  // в `deleteMany({})` и сносит таблицу `Person` целиком. Пустой список удаляет ноль строк.
  // Тем же приёмом убираются соседние спеки (`rights-content-hash-contributors.e2e-spec.ts:135`).
  afterAll(async () => {
    if (bookWithRights) {
      await prisma.rightsProfileContributorEvent.deleteMany({
        where: { rightsProfileId: bookWithRights.profile.id },
      });
      await cleanupBookWithRights(prisma, slug);
    }
    await prisma.person.deleteMany({ where: { id: { in: createdPersonIds } } });
    if (app) await app.close();
  });

  it('отдаёт привязку и отвязку участника в ответе профиля, свежие сверху', async () => {
    const before = await profileDetail();
    expect(Array.isArray(before.contributorEvents)).toBe(true);
    const countBefore = before.contributorEvents.length;

    const link = await request(http())
      .post(`/admin/source-editions/${sourceEditionId}/contributors`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        contributorId: personId,
        role: 'TRANSLATOR',
        creditedName: 'И. Иванов',
        notesRu: 'перевод с французского',
      })
      .expect(201);
    const linkId = (link.body as { id: string }).id;

    const afterLink = await profileDetail();
    expect(afterLink.contributorEvents.length).toBe(countBefore + 1);
    expect(afterLink.contributorEvents[0].eventType).toBe('LINKED');
    expect(afterLink.contributorEvents[0].rightsProfileContributorId).toBe(linkId);
    expect(afterLink.contributorEvents[0].personId).toBe(personId);

    await request(http())
      .delete(`/admin/source-editions/${sourceEditionId}/contributors/${linkId}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    const afterUnlink = await profileDetail();

    // Строки связи больше нет — и это ровно тот случай, ради которого журнал заводился.
    expect(afterUnlink.contributors.some((c) => c.id === linkId)).toBe(false);

    expect(afterUnlink.contributorEvents.length).toBe(countBefore + 2);
    const unlinked = afterUnlink.contributorEvents[0];
    expect(unlinked.eventType).toBe('UNLINKED');
    expect(unlinked.rightsProfileContributorId).toBe(linkId);
    expect(unlinked.personId).toBe(personId);
    expect(unlinked.role).toBe('TRANSLATOR');
    expect(unlinked.creditedName).toBe('И. Иванов');
    // Именно администратор, а не отвязанный участник: `LEGACY-015` требует, чтобы журнал
    // отвечал «кто», и обе величины здесь — uuid-строки, так что `expect.any` их не различит.
    expect(unlinked.createdByUserId).toBe(adminUserId);
    expect(unlinked.createdByUserId).not.toBe(personId);

    // Снимок: без него из ответа не восстановить, кого именно отвязали.
    expect(unlinked.snapshot).toMatchObject({
      birthYear: 1901,
      deathYear: 1975,
      nationalityCountryCode: 'RU',
      notesRu: 'перевод с французского',
    });
    expect(unlinked.snapshot?.linkedAt).toEqual(expect.any(String));
  });

  it('закрыт для неаутентифицированного запроса', async () => {
    await request(http()).get(`/admin/rights/profiles/${bookWithRights.profile.id}`).expect(401);
  });
});
