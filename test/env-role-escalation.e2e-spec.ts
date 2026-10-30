import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  SocialIdentityService,
  type SocialIdentity,
} from '../src/modules/auth/providers/social-identity.service';
import { httpServerOf } from './http-server';
import { createBookFixture } from './helpers/book-fixture';
import { addRoleForEmails } from '../prisma/seed-staff-roles';

/**
 * 🔴 Сторож `LEGACY-170`. Списки `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` — не
 * источник роли времени выполнения. Пока они им были, права разъезжались по
 * двум источникам истины: `RolesGuard` читал только `UserRole` и отвечал 403, а
 * `ModeratorRolesService` дописывал роль по почте — и тот же аккаунт скрывал
 * чужие комментарии и видел черновики.
 *
 * ⚠️ Почта попадает в `ADMIN_EMAILS` **после** регистрации намеренно. Заводить
 * первого администратора по этим спискам вправе только первый вход через провайдера
 * с подтверждённым адресом (`createSocialUser`, `LEGACY-443`) и `prisma/seed.ts`, и они
 * пишут строку в `UserRole` — тогда роль настоящая; регистрация паролем роли по списку
 * не даёт. Проверяется здесь другое: почта в списке, строки в базе нет.
 * Вторая половина контракта — что бутстрап жив — два последних кейса ниже и блок
 * «соцвход: роли по env-спискам» в `auth.service.spec.ts`.
 *
 * Обе половины обязаны быть красными при возврате эскалации: маршрут с
 * `@Roles(Role.Admin)` ловит только чтение из гварда, ветка `isModerator` —
 * только чтение из сервиса ролей.
 *
 * Два последних кейса — `LEGACY-443` (решение арбитра 08.10.2026): регистрация паролем роль
 * по списку не даёт (пароль адрес не доказывает), а `LEGACY-015`, пачка `T43` (решение арбитра
 * 27.09.2026): бутстрап по списку на первом входе через провайдера с подтверждённым адресом
 * пишет ровно одно событие `ROLE_ASSIGNED` с актёром `null`.
 * Откат при отказе журнала он не доказывает — это держат мутации юнит-спеки.
 */
describe('ENV role escalation e2e (LEGACY-170)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let envToken: string;
  let commentId: string;
  let bookId: string;
  let savedAdminEmails: string | undefined;

  const envEmail = `env_admin_${Date.now()}@example.com`;
  const ownerEmail = `comment_owner_${Date.now()}@example.com`;
  const bootstrapEmail = `env_bootstrap_${Date.now()}@example.com`;
  const pass = 'password123';
  const emailsToClean: string[] = [];
  const socialIdentities = new Map<string, SocialIdentity>();

  /** Присваивание `undefined` кладёт в `process.env` строку `"undefined"`. */
  const setEnv = (key: string, value: string | undefined): void => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };

  const tokenFor = async (email: string): Promise<string> => {
    const reg = await request(httpServerOf(app))
      .post('/auth/register')
      .send({ email, password: pass });
    if (reg.status === 201) return (reg.body as { accessToken: string }).accessToken;
    const login = await request(httpServerOf(app))
      .post('/auth/login')
      .send({ email, password: pass });
    return (login.body as { accessToken: string }).accessToken;
  };

  beforeAll(async () => {
    savedAdminEmails = process.env.ADMIN_EMAILS;
    // Регистрация идёт с пустым списком: иначе `register()` штатно запишет роль
    // в `UserRole`, и проверять станет нечего.
    setEnv('ADMIN_EMAILS', '');

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SocialIdentityService)
      .useValue({
        verify: (_provider: string, token: string): Promise<SocialIdentity> =>
          Promise.resolve(socialIdentities.get(token) as SocialIdentity),
      } satisfies Pick<SocialIdentityService, 'verify'>)
      .compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    envToken = await tokenFor(envEmail);
    const ownerToken = await tokenFor(ownerEmail);

    const book = await createBookFixture(prisma, `legacy170-${Date.now()}`);
    bookId = book.id;
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 't',
        author: 'a',
        description: 'd',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });

    const created = await request(httpServerOf(app))
      .post('/comments')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ bookVersionId: version.id, text: 'чужой комментарий' })
      .expect(201);
    commentId = (created.body as { id: string }).id;

    // Аккаунт заведён, строки в `UserRole` со ролью admin у него нет — и только
    // теперь почта попадает в список.
    setEnv('ADMIN_EMAILS', envEmail);
  });

  afterAll(async () => {
    setEnv('ADMIN_EMAILS', savedAdminEmails);
    await prisma.comment.deleteMany({ where: { id: commentId } });
    await prisma.bookVersion.deleteMany({ where: { bookId } });
    await prisma.book.deleteMany({ where: { id: bookId } });
    // Связи ролей сносятся до самих аккаунтов: `UserRole` ссылается на `User`
    // без каскада, и обратный порядок роняет уборку на внешнем ключе.
    const emails = [envEmail, ownerEmail, bootstrapEmail, ...emailsToClean];
    const users = await prisma.user.findMany({ where: { email: { in: emails } } });
    const userIds = users.map((u) => u.id);
    await prisma.adminAuditEvent.deleteMany({
      where: { targetType: 'USER', targetId: { in: userIds } },
    });
    await prisma.userIdentity.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma.user.deleteMany({ where: { email: { in: emails } } });
    await app.close();
  });

  it('строки admin в UserRole у этого аккаунта нет', async () => {
    const user = await prisma.user.findUnique({
      where: { email: envEmail },
      include: { roles: { include: { role: true } } },
    });
    expect(user).not.toBeNull();
    expect(user!.roles.map((r) => r.role.name)).toEqual(['user']);
  });

  it('маршрут с @Roles(Role.Admin) отвечает 403', async () => {
    await request(httpServerOf(app))
      .get('/users?page=1&limit=10')
      .set('Authorization', `Bearer ${envToken}`)
      .expect(403);
  });

  it('ветка isModerator: удаление чужого комментария запрещено', async () => {
    await request(httpServerOf(app))
      .delete(`/comments/${commentId}`)
      .set('Authorization', `Bearer ${envToken}`)
      .expect(403);
  });

  it('в /users/me уезжает только роль user', async () => {
    const res = await request(httpServerOf(app))
      .get('/users/me')
      .set('Authorization', `Bearer ${envToken}`)
      .expect(200);
    expect((res.body as { roles: string[] }).roles).toEqual(['user']);
  });

  it('регистрация паролем адреса из ADMIN_EMAILS и в другом регистре роль admin не даёт (LEGACY-443)', async () => {
    const listed = `env_listed_${Date.now()}@example.com`;
    emailsToClean.push(listed);
    setEnv('ADMIN_EMAILS', listed);
    try {
      const res = await request(httpServerOf(app))
        .post('/auth/register')
        .send({ email: listed.toUpperCase(), password: pass })
        .expect(201);
      expect((res.body as { user: { roles: string[] } }).user.roles).toEqual(['user']);
      // Тот же адрес другим регистром - тот же аккаунт, второго не заводится.
      await request(httpServerOf(app))
        .post('/auth/register')
        .send({ email: listed, password: pass })
        .expect(409);
    } finally {
      setEnv('ADMIN_EMAILS', envEmail);
    }
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: listed },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });
    expect(user.roles.map((r) => r.role.name)).toEqual(['user']);
    expect(
      await prisma.adminAuditEvent.count({ where: { targetType: 'USER', targetId: user.id } }),
    ).toBe(0);
  });

  it('бутстрап по ADMIN_EMAILS при первом входе через Google с подтверждённым адресом: одно событие ROLE_ASSIGNED с актёром null (LEGACY-015, T43; LEGACY-443)', async () => {
    socialIdentities.set('bootstrap-verified', {
      provider: 'google',
      providerUserId: `g-${bootstrapEmail}`,
      email: bootstrapEmail,
      emailVerified: true,
    });
    setEnv('ADMIN_EMAILS', bootstrapEmail);
    try {
      await request(httpServerOf(app))
        .post('/auth/social')
        .send({ provider: 'google', token: 'bootstrap-verified' })
        .expect(200);
    } finally {
      setEnv('ADMIN_EMAILS', envEmail);
    }

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: bootstrapEmail },
      select: { id: true, roles: { select: { role: { select: { name: true } } } } },
    });
    expect(user.roles.map((r) => r.role.name).sort()).toEqual(['admin', 'user']);

    const events = await prisma.adminAuditEvent.findMany({
      where: { targetType: 'USER', targetId: user.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'ROLE_ASSIGNED',
      actorUserId: null,
      payload: { role: 'admin', source: 'env_bootstrap' },
    });
  });

  it('два одновременных первых входа одной личности: оба 200, один аккаунт и одна привязка (LEGACY-468)', async () => {
    const raceEmail = `social_race_${Date.now()}@example.com`;
    emailsToClean.push(raceEmail);
    // Оба запроса проходят проверку токена вместе, до поиска аккаунта: иначе второй находил бы
    // уже созданную строку, и гонки на создании не было бы.
    let release!: () => void;
    // Не дольше 5 с: отказ второго запроса до `verify` (лимит, валидация) иначе вешал бы первый
    // до тайм-аута jest, а не ронял тест внятным статусом.
    const bothArrived = new Promise<void>((resolve) => {
      release = resolve;
      setTimeout(resolve, 5_000).unref();
    });
    let arrived = 0;
    socialIdentities.set('race', {
      provider: 'google',
      providerUserId: `g-${raceEmail}`,
      email: raceEmail,
      emailVerified: true,
    });
    const verify: Pick<SocialIdentityService, 'verify'> = app.get(SocialIdentityService);
    const plain = verify.verify;
    verify.verify = async (provider, token) => {
      arrived += 1;
      if (arrived === 2) release();
      await bothArrived;
      return plain(provider, token);
    };
    try {
      const [a, b] = await Promise.all([
        request(httpServerOf(app)).post('/auth/social').send({ provider: 'google', token: 'race' }),
        request(httpServerOf(app)).post('/auth/social').send({ provider: 'google', token: 'race' }),
      ]);
      expect([a.status, b.status]).toEqual([200, 200]);
    } finally {
      verify.verify = plain;
    }

    const users = await prisma.user.findMany({
      where: { email: raceEmail },
      select: { id: true, identities: { select: { providerUserId: true } } },
    });
    expect(users).toHaveLength(1);
    expect(users[0].identities).toEqual([{ providerUserId: `g-${raceEmail}` }]);
  });

  it('сид выдаёт роль по списку только аккаунту, чью почту назвала привязка провайдера (LEGACY-443)', async () => {
    const stamp = Date.now();
    const byPassword = `seed_pwd_${stamp}@example.com`;
    const bySocial = `seed_social_${stamp}@example.com`;
    const byOtherLink = `seed_other_${stamp}@example.com`;
    emailsToClean.push(byPassword, bySocial, byOtherLink);

    await tokenFor(byPassword);
    socialIdentities.set('seed-social', {
      provider: 'google',
      providerUserId: `g-${bySocial}`,
      email: bySocial,
      emailVerified: true,
    });
    await request(httpServerOf(app))
      .post('/auth/social')
      .send({ provider: 'google', token: 'seed-social' })
      .expect(200);
    // Привязка есть, но провайдер назвал другой адрес - он не доказывает адрес аккаунта.
    await prisma.user.create({
      data: {
        email: byOtherLink,
        languagePreference: 'en',
        identities: {
          create: {
            provider: 'google',
            providerUserId: `g-${byOtherLink}`,
            email: 'x@example.com',
          },
        },
      },
    });

    await addRoleForEmails(
      prisma,
      `${byPassword}, ${bySocial.toUpperCase()},${byOtherLink}`,
      RoleName.admin,
    );

    const admins = await prisma.userRole.findMany({
      where: {
        role: { name: RoleName.admin },
        user: { email: { in: [byPassword, bySocial, byOtherLink] } },
      },
      select: { user: { select: { email: true } } },
    });
    expect(admins.map((r) => r.user.email)).toEqual([bySocial]);
  });
});
