/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('User roles e2e', () => {
  let app: INestApplication;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('admin can list/assign/revoke roles; prevent revoking base user role', async () => {
    // Create admin
    const aEmail = 'admin@example.com';
    const aPass = 'password123';
    const regAdmin = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: aEmail, password: aPass });
    if (![201, 409].includes(regAdmin.status)) {
      throw new Error(`Unexpected admin register status: ${regAdmin.status}`);
    }
    const aLogin = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email: aEmail, password: aPass })
      .expect(200);
    const aToken = aLogin.body.accessToken as string;

    // Create normal user
    const uEmail = `roles_${Date.now()}@example.com`;
    const uPass = 'password123';
    const uReg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uEmail, password: uPass })
      .expect(201);
    const userId = uReg.body.user.id as string;

    // List roles (should contain 'user')
    const roles1 = await request(app.getHttpServer())
      .get(`/users/${userId}/roles`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(roles1.body).toContain('user');

    // Assign content_manager
    const assign = await request(app.getHttpServer())
      .post(`/users/${userId}/roles/content_manager`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(201);
    expect(assign.body.role).toBe('content_manager');

    // Verify
    const roles2 = await request(app.getHttpServer())
      .get(`/users/${userId}/roles`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(roles2.body).toContain('content_manager');

    // Revoke content_manager
    await request(app.getHttpServer())
      .delete(`/users/${userId}/roles/content_manager`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);

    const roles3 = await request(app.getHttpServer())
      .get(`/users/${userId}/roles`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(200);
    expect(roles3.body).not.toContain('content_manager');

    // Prevent revoking base user role
    await request(app.getHttpServer())
      .delete(`/users/${userId}/roles/user`)
      .set('Authorization', `Bearer ${aToken}`)
      .expect(400);
  });

  it('non-admin forbidden on role management', async () => {
    const uEmail = `roles_forbid_${Date.now()}@example.com`;
    const uPass = 'password123';
    const reg = await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email: uEmail, password: uPass })
      .expect(201);
    const uToken = reg.body.accessToken as string;

    await request(app.getHttpServer())
      .get(`/users/${reg.body.user.id}/roles`)
      .set('Authorization', `Bearer ${uToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .post(`/users/${reg.body.user.id}/roles/content_manager`)
      .set('Authorization', `Bearer ${uToken}`)
      .expect(403);

    await request(app.getHttpServer())
      .delete(`/users/${reg.body.user.id}/roles/content_manager`)
      .set('Authorization', `Bearer ${uToken}`)
      .expect(403);
  });
});
