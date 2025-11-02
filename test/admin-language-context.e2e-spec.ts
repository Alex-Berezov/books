/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';

describe('Admin language context (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    process.env.ADMIN_EMAILS = 'admin@example.com';
    const email = 'admin@example.com';
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      adminToken = reg.body.accessToken as string;
    } else if (reg.status === 409) {
      const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
      adminToken = login.body.accessToken as string;
    } else {
      throw new Error(`Admin register unexpected status ${reg.status}`);
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates Page in language from X-Admin-Language and lists only that language by default', async () => {
    const slug = `admin-page-${Date.now()}`;

    // Create ES page via header, while path lang is en → header must win
    const created = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .send({
        slug,
        title: 'Sobre',
        type: 'generic',
        content: 'Contenido ES',
      })
      .expect(201);
    expect(created.body.language).toBe(Language.es);

    // List default (should be ES because header > path)
    const listEs = await request(http())
      .get('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .expect(200);
    const foundEs = (listEs.body.data as any[]).some((p) => p.slug === slug && p.language === 'es');
    expect(foundEs).toBe(true);

    // Ensure not shown in EN listing by default when header=en
    const listEn = await request(http())
      .get('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.en)
      .expect(200);
    const foundEn = (listEn.body.data as any[]).some((p) => p.slug === slug && p.language === 'en');
    expect(foundEn).toBe(false);
  });

  it('creates BookVersion in language from X-Admin-Language and lists by that language unless overridden by query', async () => {
    const book = await prisma.book.create({ data: { slug: `admin-langs-book-${Date.now()}` } });

    // Create ES version via admin endpoint; dto.language is ignored
    const vEs = await request(http())
      .post(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .send({
        language: Language.en, // should be ignored
        title: 'ES Version',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/es.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    expect(vEs.body.language).toBe(Language.es);

    // Default admin listing — ES
    const listEs = await request(http())
      .get(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .expect(200);
    expect(Array.isArray(listEs.body)).toBe(true);
    expect((listEs.body as any[]).every((v) => v.language === 'es')).toBe(true);

    // Override to EN via query
    const listEn = await request(http())
      .get(`/admin/en/books/${book.id}/versions?language=en`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .expect(200);
    expect(Array.isArray(listEn.body)).toBe(true);
    expect((listEn.body as any[]).length).toBe(0); // no EN versions yet
  });

  it('uses path :lang as effective admin language when X-Admin-Language is absent (smoke)', async () => {
    // Pages
    const slug = `admin-page-path-${Date.now()}`;
    const createdPage = await request(http())
      .post('/admin/fr/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        slug,
        title: 'À propos',
        type: 'generic',
        content: 'FR contenu',
        language: Language.en, // should be ignored
      })
      .expect(201);
    expect(createdPage.body.language).toBe(Language.fr);

    const listFr = await request(http())
      .get('/admin/fr/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((listFr.body.data as any[]).some((p) => p.slug === slug && p.language === 'fr')).toBe(
      true,
    );

    const listEn = await request(http())
      .get('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((listEn.body.data as any[]).some((p) => p.slug === slug)).toBe(false);

    // BookVersions
    const book = await prisma.book.create({
      data: { slug: `admin-langs-book-path-${Date.now()}` },
    });
    const vFr = await request(http())
      .post(`/admin/fr/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en, // should be ignored
        title: 'FR Version',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/fr.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    expect(vFr.body.language).toBe(Language.fr);

    const listFrV = await request(http())
      .get(`/admin/fr/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((listFrV.body as any[]).every((v) => v.language === 'fr')).toBe(true);

    const listEnV = await request(http())
      .get(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    expect((listEnV.body as any[]).length).toBe(0);
  });

  it('ignores DTO.language on admin Page create and rejects duplicate for same language+slug', async () => {
    const slug = `neg-admin-page-${Date.now()}`;

    // Create ES page while DTO.language says EN — effective should be ES
    const created = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .send({
        slug,
        title: 'Neg ES',
        type: 'generic',
        content: 'neg es',
        language: Language.en, // ignored
      })
      .expect(201);
    expect(created.body.language).toBe(Language.es);

    // Try to create duplicate in the same effective language — must fail 400
    const dup = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.es)
      .send({
        slug,
        title: 'Neg ES Dup',
        type: 'generic',
        content: 'neg es dup',
      })
      .expect(400);
    expect(String(dup.body.message || '')).toMatch(/already exists/i);

    // Creating same slug in different effective language should succeed
    const createdEn = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.en)
      .send({
        slug,
        title: 'Neg EN',
        type: 'generic',
        content: 'neg en',
      })
      .expect(201);
    expect(createdEn.body.language).toBe(Language.en);
  });

  it('ignores DTO.language on admin BookVersion create and rejects duplicate for same book+language', async () => {
    const book = await prisma.book.create({ data: { slug: `neg-admin-book-${Date.now()}` } });

    // Create FR version while DTO.language says EN — effective should be FR
    const vFr = await request(http())
      .post(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.fr)
      .send({
        language: Language.en, // ignored
        title: 'Neg FR',
        author: 'Auth',
        description: 'Desc',
        coverImageUrl: 'https://example.com/fr.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    expect(vFr.body.language).toBe(Language.fr);

    // Try to create duplicate FR version for same book — must fail 400
    const dupFr = await request(http())
      .post(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.fr)
      .send({
        language: Language.en, // ignored, required by DTO
        title: 'Neg FR Dup',
        author: 'Auth',
        description: 'Desc',
        coverImageUrl: 'https://example.com/fr2.jpg',
        type: BookType.text,
        isFree: false,
      })
      .expect(400);
    expect(String(dupFr.body.message || '')).toMatch(/already exists/i);

    // Creating EN version for the same book should succeed
    const vEn = await request(http())
      .post(`/admin/en/books/${book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .set('X-Admin-Language', Language.en)
      .send({
        language: Language.fr, // ignored, required by DTO
        title: 'Neg EN',
        author: 'Auth',
        description: 'Desc',
        coverImageUrl: 'https://example.com/en.jpg',
        type: BookType.text,
        isFree: false,
      })
      .expect(201);
    expect(vEn.body.language).toBe(Language.en);
  });
});
