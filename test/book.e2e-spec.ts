import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { BookService } from '../src/modules/book/book.service';

describe('Books (e2e) - slug validation', () => {
  let app: INestApplication;

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
  });

  afterAll(async () => {
    await app.close();
  });

  it('should accept valid slug', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .send({ slug: 'valid-slug-123' })
      .expect(201);
  });

  it('should reject invalid slug (uppercase)', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .send({ slug: 'Invalid' })
      .expect(400);
  });

  it('should reject invalid slug (double hyphen)', async () => {
    await request(app.getHttpServer() as unknown as Parameters<typeof request>[0])
      .post('/books')
      .send({ slug: 'bad--slug' })
      .expect(400);
  });
});
