import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

/**
 * 🔴 Сторож `LEGACY-170`. Списки `ADMIN_EMAILS` / `CONTENT_MANAGER_EMAILS` — не
 * источник роли времени выполнения. Пока они им были, права разъезжались по
 * двум источникам истины: `RolesGuard` читал только `UserRole` и отвечал 403, а
 * `ModeratorRolesService` дописывал роль по почте — и тот же аккаунт скрывал
 * чужие комментарии и видел черновики.
 *
 * ⚠️ Почта попадает в `ADMIN_EMAILS` **после** регистрации намеренно. Заводить
 * первого администратора по этим спискам `register()` и `prisma/seed.ts` по-
 * прежнему вправе (`LEGACY-070`), и они пишут строку в `UserRole` — тогда роль
 * настоящая. Проверяется здесь другое: почта в списке, строки в базе нет.
 * Вторая половина контракта — что бутстрап жив — лежит в юните
 * `auth.service.spec.ts` («register: почта из ADMIN_EMAILS пишет роль в БД»).
 *
 * Обе половины обязаны быть красными при возврате эскалации: маршрут с
 * `@Roles(Role.Admin)` ловит только чтение из гварда, ветка `isModerator` —
 * только чтение из сервиса ролей.
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
  const pass = 'password123';

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

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    envToken = await tokenFor(envEmail);
    const ownerToken = await tokenFor(ownerEmail);

    const book = await prisma.book.create({ data: { slug: `legacy170-${Date.now()}` } });
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
    const emails = [envEmail, ownerEmail];
    const users = await prisma.user.findMany({ where: { email: { in: emails } } });
    await prisma.userRole.deleteMany({ where: { userId: { in: users.map((u) => u.id) } } });
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
});
