/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- тело ответа и сервер supertest типизированы как any */
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JwtService } from '@nestjs/jwt';
import request from 'supertest';
import { RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { SocialIdentityService } from '../src/modules/auth/providers/social-identity.service';
import type {
  SocialIdentity,
  SocialProvider,
} from '../src/modules/auth/providers/social-identity.service';
import { requireJwtAccessSecret, requireJwtRefreshSecret } from '../src/common/config/jwt-secrets';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * 🔴 `LEGACY-451`, `LEGACY-452` (пачка `T122`, решение арбитра 10.10.2026, `decisions-log.md`).
 *
 * До правки выход ничего не гасил, refresh продлевал сессию бесконечно, а `isActive=false`
 * не читал ни один путь входа. Каждый сценарий ниже — путь, по которому погашенная сессия
 * продолжала работать.
 *
 * ⚠️ Окно отзыва. Проверка access идёт через процессный кэш на `ROLES_CACHE_TTL_MS`
 * (по умолчанию 5 с). Здесь один экземпляр приложения, и запись сбрасывает кэш сразу,
 * поэтому отказ ожидается немедленно. На другом экземпляре того же прода старый access
 * живёт до TTL — это принятая цена, а не дефект, и в этих ожиданиях её нет.
 */
describe('Сессии: отзыв и блокировка (LEGACY-451, LEGACY-452)', () => {
  let app: INestApplication;
  let adminToken: string;
  const password = 'password123';
  const verified = new Map<string, SocialIdentity>();

  const http = () => app.getHttpServer();

  const socialStub: Pick<SocialIdentityService, 'verify'> = {
    verify: (provider: SocialProvider, token: string) => {
      const identity = verified.get(`${provider}:${token}`);
      if (!identity) return Promise.reject(new UnauthorizedException('Invalid token'));
      return Promise.resolve(identity);
    },
  };

  /** Новый пользователь с парой токенов входа. */
  async function signUp(tag: string) {
    const email = `t122_${tag}_${Date.now()}@example.com`;
    const reg = await request(http()).post('/auth/register').send({ email, password }).expect(201);
    return {
      id: reg.body.user.id as string,
      email,
      accessToken: reg.body.accessToken as string,
      refreshToken: reg.body.refreshToken as string,
    };
  }

  const me = (accessToken: string) =>
    request(http()).get('/users/me').set('Authorization', `Bearer ${accessToken}`);

  const refresh = (refreshToken: string) =>
    request(http()).post('/auth/refresh').send({ refreshToken });

  const adminPatch = (id: string, body: Record<string, unknown>) =>
    request(http())
      .patch(`/users/${id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send(body)
      .expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SocialIdentityService)
      .useValue(socialStub)
      .compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const admin = await signUp('admin');
    await grantStaffRoles(app, admin.email, [RoleName.admin]);
    const login = await request(http())
      .post('/auth/login')
      .send({ email: admin.email, password })
      .expect(200);
    adminToken = login.body.accessToken;
  });

  afterAll(async () => {
    await app.close();
  });

  it('выход гасит refresh и access; повтор выхода тем же токеном — 200', async () => {
    const u = await signUp('logout');
    await me(u.accessToken).expect(200);

    await request(http())
      .post('/auth/logout')
      .send({ refreshToken: u.refreshToken })
      .expect(200, { success: true });

    await refresh(u.refreshToken).expect(401);
    await me(u.accessToken).expect(401);
    await request(http()).post('/auth/logout').send({ refreshToken: u.refreshToken }).expect(200);
  });

  it('выход с подделанным токеном — 401, сессия владельца жива', async () => {
    const u = await signUp('forged');
    await request(http())
      .post('/auth/logout')
      .send({ refreshToken: `${u.refreshToken}x` })
      .expect(401);
    await me(u.accessToken).expect(200);
    await refresh(u.refreshToken).expect(200);
  });

  it('выход без тела — 400, с просроченным refresh — 401; версия не растёт', async () => {
    const u = await signUp('logout-shape');
    await request(http()).post('/auth/logout').send({}).expect(400);

    const jwt = app.get(JwtService);
    // `iat` в прошлом и срок в секунду: `exp` уже позади, подпись настоящая.
    const expired = await jwt.signAsync(
      { sub: u.id, email: u.email, tv: 0, iat: Math.floor(Date.now() / 1000) - 120 },
      { secret: requireJwtRefreshSecret(), expiresIn: 1 },
    );
    await request(http()).post('/auth/logout').send({ refreshToken: expired }).expect(401);

    await me(u.accessToken).expect(200);
    await refresh(u.refreshToken).expect(200);
  });

  it('повторный выход старым токеном не гасит сессию, открытую после него', async () => {
    const u = await signUp('relogout');
    await request(http()).post('/auth/logout').send({ refreshToken: u.refreshToken }).expect(200);
    const login = await request(http())
      .post('/auth/login')
      .send({ email: u.email, password })
      .expect(200);

    await request(http()).post('/auth/logout').send({ refreshToken: u.refreshToken }).expect(200);

    await me(login.body.accessToken).expect(200);
    await refresh(login.body.refreshToken).expect(200);
  });

  it('смена пароля админом гасит старые access и refresh; новый пароль входит', async () => {
    const u = await signUp('password');
    await adminPatch(u.id, { password: 'brand-new-pass' });

    await me(u.accessToken).expect(401);
    await refresh(u.refreshToken).expect(401);
    await request(http())
      .post('/auth/login')
      .send({ email: u.email, password: 'brand-new-pass' })
      .expect(200);
  });

  it('смена ролей гасит выданные токены', async () => {
    const u = await signUp('roles');
    await request(http())
      .post(`/users/${u.id}/roles/content_manager`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    await me(u.accessToken).expect(401);
    await refresh(u.refreshToken).expect(401);
  });

  it('снятие роли гасит выданные токены', async () => {
    const u = await signUp('revoke-role');
    await request(http())
      .post(`/users/${u.id}/roles/content_manager`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);
    const login = await request(http())
      .post('/auth/login')
      .send({ email: u.email, password })
      .expect(200);
    await me(login.body.accessToken).expect(200);

    await request(http())
      .delete(`/users/${u.id}/roles/content_manager`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await me(login.body.accessToken).expect(401);
    await refresh(login.body.refreshToken).expect(401);
  });

  it('удалённый пользователь: старые access и refresh — 401', async () => {
    const u = await signUp('deleted');
    await me(u.accessToken).expect(200);

    await request(http())
      .delete(`/users/${u.id}`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    await me(u.accessToken).expect(401);
    await refresh(u.refreshToken).expect(401);
  });

  it('маршрут с необязательным токеном: погашенный access — 401, а не ответ анониму', async () => {
    const u = await signUp('optional');
    const path = '/en/books/t122-no-such-book/reader-bootstrap';
    const anonymous = await request(http()).get(path);
    expect(anonymous.status).not.toBe(401);

    await request(http()).post('/auth/logout').send({ refreshToken: u.refreshToken }).expect(200);

    await request(http()).get(path).set('Authorization', `Bearer ${u.accessToken}`).expect(401);
  });

  it('блокировка: старый access, refresh, вход паролем и вход провайдером — 401', async () => {
    const u = await signUp('blocked');
    verified.set('google:blocked-token', {
      provider: 'google',
      providerUserId: `g-blocked-${u.id}`,
      email: u.email,
      emailVerified: true,
    });

    await adminPatch(u.id, { isActive: false });

    await me(u.accessToken).expect(401);
    await refresh(u.refreshToken).expect(401);
    const login = await request(http()).post('/auth/login').send({ email: u.email, password });
    expect(login.status).toBe(401);
    expect(login.body.message).toBe('Account is disabled');
    const social = await request(http())
      .post('/auth/social')
      .send({ provider: 'google', token: 'blocked-token' });
    expect(social.status).toBe(401);
    expect(social.body.message).toBe('Account is disabled');

    // Разблокировка возвращает вход, но не старые токены: версия уже поднята.
    await adminPatch(u.id, { isActive: true });
    await request(http()).post('/auth/login').send({ email: u.email, password }).expect(200);
    await refresh(u.refreshToken).expect(401);
  });

  it('refresh не продлевает сессию: новая пара наследует exp исходного refresh', async () => {
    const u = await signUp('sliding');
    const jwt = app.get(JwtService);
    const original = jwt.decode<{ exp: number }>(u.refreshToken);
    // `exp` считается в секундах: без паузы полный срок от «сейчас» совпал бы с исходным,
    // и продление осталось бы незамеченным.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const first = await refresh(u.refreshToken).expect(200);
    const second = await refresh(first.body.refreshToken).expect(200);

    expect(jwt.decode<{ exp: number }>(first.body.refreshToken).exp).toBe(original.exp);
    expect(jwt.decode<{ exp: number }>(second.body.refreshToken).exp).toBe(original.exp);
    expect(jwt.decode<{ exp: number }>(second.body.accessToken).exp).toBeLessThanOrEqual(
      original.exp,
    );
  });

  it('access, выданный до T122 (без tv), живёт до своего срока', async () => {
    const u = await signUp('legacy');
    const jwt = app.get(JwtService);
    const legacyAccess = await jwt.signAsync(
      { sub: u.id, email: u.email, roles: ['user'] },
      { secret: requireJwtAccessSecret(), expiresIn: '5m' },
    );
    await me(legacyAccess).expect(200);
  });
});
