import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { BookService } from '../src/modules/book/book.service';

describe('Books (e2e) - slug validation', () => {
  let app: INestApplication;
  let adminToken: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(BookService)
      .useValue({
        create: jest.fn((dto: { slug: string }) => ({ id: '1', ...dto })),
      })
      .compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    // Prepare admin auth to pass RBAC on write endpoints
    const server = app.getHttpServer() as unknown as Parameters<typeof request>[0];
    const adminEmail = 'books-admin@test.local';
    const adminPassword = 'Passw0rd!';
    process.env.ADMIN_EMAILS = adminEmail;

    // try register; if exists, login
    const reg = await request(server).post('/auth/register').send({
      email: adminEmail,
      password: adminPassword,
      name: 'Books Admin',
      languagePreference: 'en',
    });
    if (reg.status === 201) {
      adminToken = (reg.body as { accessToken: string }).accessToken;
    } else {
      const login = await request(server)
        .post('/auth/login')
        .send({ email: adminEmail, password: adminPassword });
      adminToken = (login.body as { accessToken: string }).accessToken;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('should accept valid slug', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'valid-slug-123' })
      .expect(201);
  });

  it('should reject invalid slug (uppercase)', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'Invalid' })
      .expect(400);
  });

  it('should reject invalid slug (double hyphen)', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ slug: 'bad--slug' })
      .expect(400);
  });
});
