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
 * Control landings for CR auth-social, step 3.
 *
 * The provider itself is stubbed: Google's JWKS and Facebook's Graph API are
 * network services, and a landing that depends on them tests the network. What
 * each provider accepts is pinned in social-identity.service.spec.ts; what is
 * pinned here is that the route uses the *verified answer* and nothing else.
 *
 * Landing 1 is now in its full CR form: no provider token, no session at all.
 * During step 1 it could only be the weaker "no elevated role", because the
 * frontend still sent the old shape.
 */
describe('POST /auth/social (CR auth-social, step 3)', () => {
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
  it('landing 2g: the session belongs to the token holder', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'google', token: 'good-google-token' })
      .expect(200);

    expect(res.body.user.email).toBe('google-real@example.com');
    expect(res.body.user.roles).toEqual([RoleName.user]);
  });

  it('landing 2f: the same holds for Facebook', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'facebook', token: 'good-facebook-token' })
      .expect(200);

    expect(res.body.user.email).toBe('facebook-real@example.com');
  });

  // Landing 1/3 in full form: naming an account buys nothing at all any more.
  // This is the exact request that used to return an admin session.
  it('landing 1: an admin e-mail with no token gets no session', async () => {
    const res = await request(app.getHttpServer())
      .post('/auth/social')
      .send({ email: ADMIN_EMAIL, provider: 'google', name: 'Whoever' })
      .expect(400);

    expect(res.body.accessToken).toBeUndefined();
  });

  // The old fields are rejected outright rather than ignored: a field that is
  // still accepted is a field a later change can start trusting again.
  it('landing 1: the retired body fields are refused, not silently dropped', async () => {
    await request(app.getHttpServer())
      .post('/auth/social')
      .send({ provider: 'google', token: 'good-google-token', email: ADMIN_EMAIL })
      .expect(400);
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
