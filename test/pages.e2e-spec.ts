/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';

describe('Pages e2e', () => {
  let app: INestApplication;
  let adminAccess: string;
  let pageId: string;
  let slug: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // login admin
    const password = 'password123';
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

  it('CRUD page (admin) and public visibility with publish/unpublish', async () => {
    slug = `about-e2e-${Date.now()}`;

    // create page (draft by default)
    const createRes = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug,
        title: 'About project',
        type: 'generic',
        content: 'Hello world',
        language: 'en',
      })
      .expect(201);
    pageId = createRes.body.id as string;

    // public get should be 404 while draft
    await request(http()).get(`/pages/${slug}`).expect(404);

    // publish
    await request(http())
      .patch(`/admin/en/pages/${pageId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // public get should return the page
    const pub = await request(http()).get(`/pages/${slug}`).expect(200);
    expect(pub.body.slug).toBe(slug);

    // update title
    await request(http())
      .patch(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ title: 'About updated' })
      .expect(200);

    // admin list
    await request(http())
      .get('/admin/en/pages?page=1&limit=5')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // unpublish
    await request(http())
      .patch(`/admin/en/pages/${pageId}/unpublish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    await request(http()).get(`/pages/${slug}`).expect(404);

    // delete
    await request(http())
      .delete(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
});
