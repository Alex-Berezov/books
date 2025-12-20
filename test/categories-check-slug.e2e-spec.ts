/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
import * as request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Categories: Check Slug (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  beforeAll(async () => {
    const adminEmail = 'admin-cat-slug@test.com';
    const adminPassword = 'password123';
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

    // Register or login admin user
    const regRes = await request(app.getHttpServer()).post('/auth/register').send({
      email: adminEmail,
      password: adminPassword,
    });

    if (regRes.status === 201) {
      adminToken = regRes.body.accessToken;
    } else if (regRes.status === 409) {
      const loginRes = await request(app.getHttpServer()).post('/auth/login').send({
        email: adminEmail,
        password: adminPassword,
      });
      adminToken = loginRes.body.accessToken;
    } else {
      throw new Error(`Unexpected admin register status: ${regRes.status}`);
    }

    // Cleanup
    await prisma.category.deleteMany({
      where: {
        slug: { in: ['test-cat-unique', 'test-cat-existing', 'test-cat-existing-2'] },
      },
    });
  });

  afterAll(async () => {
    await prisma.category.deleteMany({
      where: {
        slug: { in: ['test-cat-unique', 'test-cat-existing', 'test-cat-existing-2'] },
      },
    });
    await app.close();
  });

  describe('GET /categories/check-slug', () => {
    it('should return exists: false for unique slug', async () => {
      const response = await request(app.getHttpServer())
        .get('/categories/check-slug')
        .query({ slug: 'test-cat-unique' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });
    });

    it('should return exists: true and suggest alternative for taken slug', async () => {
      // Create a category
      await prisma.category.create({
        data: {
          slug: 'test-cat-existing',
          name: 'Existing Category',
          type: 'genre',
        },
      });

      const response = await request(app.getHttpServer())
        .get('/categories/check-slug')
        .query({ slug: 'test-cat-existing' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body.exists).toBe(true);
      expect(response.body.suggestedSlug).toBe('test-cat-existing-2');
      expect(response.body.existingCategory).toBeDefined();
      expect(response.body.existingCategory.slug).toBe('test-cat-existing');
    });

    it('should return exists: false when excluding own id', async () => {
      const category = await prisma.category.findFirst({ where: { slug: 'test-cat-existing' } });

      const response = await request(app.getHttpServer())
        .get('/categories/check-slug')
        .query({ slug: 'test-cat-existing', excludeId: category?.id })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      expect(response.body).toEqual({
        exists: false,
      });
    });

    it('should validate slug format', async () => {
      await request(app.getHttpServer())
        .get('/categories/check-slug')
        .query({ slug: 'Invalid Slug!' })
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(400);
    });
  });
});
