/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

interface GeoBlockRuleCreateDelegate {
  create(args: { data: Record<string, unknown> }): Promise<{ id: string }>;
}

interface PrismaWithGeoBlockRule {
  geoBlockRule: GeoBlockRuleCreateDelegate;
}

describe('GeoIP market blocking e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let textVersionId: string;
  let audioVersionId: string;
  let chapterId: string;
  let audioChapterId: string;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    process.env.ENABLE_GEO_TEST_HEADERS = 'true';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    const book = await prisma.book.create({ data: { slug: `geo-block-e2e-${Date.now()}` } });
    const previewMedia = await prisma.mediaAsset.create({
      data: {
        key: `geo-block-preview-${Date.now()}.mp3`,
        url: 'https://example.com/geo-block-preview.mp3',
        contentType: 'audio/mpeg',
        size: 100,
        duration: 30,
      },
    });
    const textVersion = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'Geo-block text',
        author: 'Test',
        description: 'Geo-block text test version',
        coverImageUrl: 'https://example.com/geo-block-text.jpg',
        type: 'text',
        isFree: true,
        status: 'published',
        publishedAt: new Date(),
      },
    });
    const audioVersion = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'fr',
        title: 'Geo-block audio',
        author: 'Test',
        description: 'Geo-block audio test version',
        coverImageUrl: 'https://example.com/geo-block-audio.jpg',
        type: 'audio',
        isFree: true,
        status: 'published',
        publishedAt: new Date(),
        previewMediaId: previewMedia.id,
      },
    });
    textVersionId = textVersion.id;
    audioVersionId = audioVersion.id;

    const chapter = await prisma.chapter.create({
      data: {
        bookVersionId: textVersionId,
        number: 1,
        title: 'Chapter',
        content: 'Protected text',
      },
    });
    chapterId = chapter.id;
    const audioChapter = await prisma.audioChapter.create({
      data: {
        bookVersionId: audioVersionId,
        number: 1,
        title: 'Audio chapter',
        audioUrl: 'https://example.com/protected.mp3',
        duration: 60,
      },
    });
    audioChapterId = audioChapter.id;

    const database = prisma as unknown as PrismaWithGeoBlockRule;
    await database.geoBlockRule.create({
      data: {
        bookId: book.id,
        bookVersionId: textVersionId,
        scope: 'LANGUAGE_EDITION',
        countryCode: 'GB',
        accessPolicy: 'BLOCK',
        sourceFinalStatus: 'BLOCKED',
        isActive: true,
        generatedFrom: 'E2E_TEST',
      },
    });
    await database.geoBlockRule.create({
      data: {
        bookId: book.id,
        bookVersionId: audioVersionId,
        scope: 'LANGUAGE_EDITION',
        countryCode: 'GB',
        accessPolicy: 'BLOCK',
        sourceFinalStatus: 'BLOCKED',
        isActive: true,
        generatedFrom: 'E2E_TEST',
      },
    });

    const password = 'password123';
    const registration = await request(http())
      .post('/auth/register')
      .send({ email: 'admin@example.com', password });
    if (registration.status === 201) {
      adminAccess = registration.body.accessToken as string;
    } else {
      const login = await request(http())
        .post('/auth/login')
        .send({ email: 'admin@example.com', password })
        .expect(200);
      adminAccess = login.body.accessToken as string;
    }
  });

  afterAll(async () => {
    await app.close();
  });

  it('returns 451 for a blocked version and 200 for an allowed country', async () => {
    await request(http())
      .get(`/versions/${textVersionId}`)
      .set('X-Geo-Country', 'GB')
      .expect(451)
      .expect(({ body }) => {
        expect(body.code).toBe('GEO_BLOCKED_BY_RIGHTS');
      });
    await request(http()).get(`/versions/${textVersionId}`).set('X-Geo-Country', 'US').expect(200);
  });

  it('blocks chapter list and chapter detail', async () => {
    await request(http())
      .get(`/versions/${textVersionId}/chapters`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
    await request(http()).get(`/chapters/${chapterId}`).set('X-Geo-Country', 'GB').expect(451);
  });

  it('blocks audio list, audio detail and preview URL disclosure', async () => {
    await request(http())
      .get(`/versions/${audioVersionId}/audio-chapters`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
    await request(http())
      .get(`/audio-chapters/${audioChapterId}`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
    await request(http())
      .get(`/versions/${audioVersionId}/preview`)
      .set('X-Geo-Country', 'GB')
      .expect(451);
  });

  it('does not apply public GeoIP enforcement to the admin version endpoint', async () => {
    await request(http())
      .get(`/admin/versions/${textVersionId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .set('X-Geo-Country', 'GB')
      .expect(200);
  });
});
