/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { SocialIdentityService } from '../src/modules/auth/providers/social-identity.service';
import { Language, RoleName } from '@prisma/client';
import type {
  SocialIdentity,
  SocialProvider,
} from '../src/modules/auth/providers/social-identity.service';

/**
 * Control landings for CR auth-social, step 1.
 *
 * The provider itself is stubbed: Google's JWKS and Facebook's Graph API are
 * network services, and a landing that depends on them tests the network. What
 * each provider accepts is pinned in social-identity.service.spec.ts; what is
 * pinned here is that the route uses the *verified answer* and nothing else.
 *
 * Note on landing 1 as written in the CR ("no token → 401/403"): that is a
 * step 3 criterion. Step 1 must still accept the legacy body, because
 * books-front has not been redeployed yet. What step 1 guarantees instead is
 * that the unproven path carries no elevated role — landing 3 below.
 */
describe('POST /auth/social (CR auth-social, step 1)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  const verified = new Map<string, SocialIdentity>();

  const stub: Pick<SocialIdentityService, 'verify'> = {
    verify: (provider: SocialProvider, token: string) => {
      const identity = verified.get(`${provider}:${token}`);
      if (!identity) return Promise.reject(new UnauthorizedException('Invalid token'));
      return Promise.resolve(identity);
    },
  };

  const ADMIN_EMAIL = 'social-admin@example.com';

  beforeAll(async () => {
    verified.set('google:good-google-token', {
      provider: 'google',
      providerUserId: 'g-1',
      email: 'google-real@example.com',
      name: 'Google Real',
    });
    verified.set('facebook:good-facebook-token', {
      provider: 'facebook',
      providerUserId: 'fb-1',
      email: 'facebook-real@example.com',
    });
    verified.set('google:admin-google-token', {
      provider: 'google',
      providerUserId: 'g-admin',
      email: ADMIN_EMAIL,
    });

    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(SocialIdentityService)
      .useValue(stub)
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();

    prisma = app.get(PrismaService);

    // An account that really is an administrator in the database — otherwise
    // "no admin role in the response" would be true for the wrong reason.
    const adminRole = await prisma.role.upsert({
      where: { name: RoleName.admin },
      update: {},
      create: { name: RoleName.admin },
    });
    const userRole = await prisma.role.upsert({
      where: { name: RoleName.user },
      update: {},
      create: { name: RoleName.user },
    });
    const admin = await prisma.user.upsert({
      where: { email: ADMIN_EMAIL },
      update: {},
      create: { email: ADMIN_EMAIL, languagePreference: Language.en },
    });
    for (const role of [adminRole, userRole]) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: admin.id, roleId: role.id } },
        create: { userId: admin.id, roleId: role.id },
        update: {},
      });
    }
  });

  afterAll(async () => {
    await app.close();
  });

  // Landing 1g / 1f: a token the provider refuses buys nothing.
  it('landing 1g: a rejected Google token yields no session', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'google', token: 'garbage' })
      .expect(401);

    expect(res.body.accessToken).toBeUndefined();
  });

  it('landing 1f: a rejected Facebook token yields no session', async () => {
    await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'facebook', token: 'garbage' })
      .expect(401);
  });

  // Landing 2g / 2f — the most telling one. It separates "we started verifying
  // the token" from "we started verifying the token but still read the e-mail
  // out of the body", which would leave the hole exactly where it was.
  it('landing 2g: the session belongs to the token holder, not to the body e-mail', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'google', token: 'good-google-token', email: ADMIN_EMAIL })
      .expect(200);

    expect(res.body.user.email).toBe('google-real@example.com');
    expect(res.body.user.roles).toEqual([RoleName.user]);
  });

  it('landing 2f: the same holds for Facebook', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'facebook', token: 'good-facebook-token', email: ADMIN_EMAIL })
      .expect(200);

    expect(res.body.user.email).toBe('facebook-real@example.com');
  });

  // Landing 3: the legacy shape proves nothing, so it must not carry the roles
  // the account really has. Roles come from the database, so without an
  // explicit restriction this request would hand back an admin token.
  it('landing 3: the unproven legacy path issues no elevated role', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ email: ADMIN_EMAIL, provider: 'google', name: 'Whoever' })
      .expect(200);

    expect(res.body.user.email).toBe(ADMIN_EMAIL);
    expect(res.body.user.roles).toEqual([RoleName.user]);
  });

  it('a proven administrator keeps the roles stored in the database', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'google', token: 'admin-google-token' })
      .expect(200);

    expect(res.body.user.roles).toEqual(expect.arrayContaining([RoleName.admin, RoleName.user]));
  });

  it('rejects a token without a provider', async () => {
    await request(app.getHttpServer())
      .post('/auth/social')
      .send({ token: 'good-google-token' })
      .expect(400);
  });

  it('rejects an unknown provider outright', async () => {
    await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'myspace', token: 'x' })
      .expect(400);
  });

  it('rejects a body with neither a token nor an e-mail', async () => {
    await request(app.getHttpServer()).post('/auth/social').send({}).expect(400);
  });
});
