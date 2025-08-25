/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Categories e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminAccess: string;
  let versionId: string;
  let categoryId: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // create book + version
    const book = await prisma.book.create({ data: { slug: `book-cat-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    versionId = version.id;

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

  it('CRUD category (admin only) and attach/detach to version', async () => {
    // create category
    const createRes = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ type: 'genre', name: 'Fantasy E2E', slug: `fantasy-e2e-${Date.now()}` })
      .expect(201);
    categoryId = createRes.body.id as string;

    // list
    await request(http()).get('/categories?page=1&limit=1').expect(200);

    // update
    await request(http())
      .patch(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ name: 'Fantasy Updated' })
      .expect(200);

    // attach
    await request(http())
      .post(`/versions/${versionId}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId })
      .expect(201);

    // duplicate attach is idempotent
    await request(http())
      .post(`/versions/${versionId}/categories`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ categoryId })
      .expect(201);

    // get books by category slug
    const cat = await prisma.category.findUnique({ where: { id: categoryId } });
    await request(http()).get(`/categories/${cat?.slug}/books`).expect(200);

    // create child category
    const childRes = await request(http())
      .post('/categories')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        type: 'genre',
        name: 'Dark Fantasy',
        slug: `dark-fantasy-e2e-${Date.now()}`,
        parentId: categoryId,
      })
      .expect(201);
    const childId = childRes.body.id as string;

    // get children
    await request(http()).get(`/categories/${categoryId}/children`).expect(200);

    // get tree
    await request(http()).get('/categories/tree').expect(200);

    // try delete parent (should fail)
    await request(http())
      .delete(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);

    // move child to root
    await request(http())
      .patch(`/categories/${childId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ parentId: null })
      .expect(200);

    // detach
    await request(http())
      .delete(`/versions/${versionId}/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // delete category and child
    await request(http())
      .delete(`/categories/${categoryId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await request(http())
      .delete(`/categories/${childId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
});
