/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { MediaProbeService } from '../src/modules/media-jobs/media-probe.service';
import { MediaCleanupService } from '../src/modules/media-jobs/media-cleanup.service';

describe('Media jobs e2e', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let probe: MediaProbeService;
  let cleanup: MediaCleanupService;
  let adminAccess: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    process.env.ADMIN_EMAILS = 'admin@example.com';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    probe = moduleRef.get(MediaProbeService);
    cleanup = moduleRef.get(MediaCleanupService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    await request(http()).post('/api/auth/register').send({
      email: 'admin@example.com',
      password: 'Password1!',
      name: 'Admin',
    });
    const adminLogin = await request(http())
      .post('/api/auth/login')
      .send({ email: 'admin@example.com', password: 'Password1!' });
    adminAccess = adminLogin.body.accessToken as string;
  });

  afterAll(async () => {
    await app.close();
  });

  it('probe.runProbe skips non-audio assets', async () => {
    const asset = await prisma.mediaAsset.create({
      data: {
        key: `img-${Date.now()}.jpg`,
        url: 'http://localhost:5000/x.jpg',
        contentType: 'image/jpeg',
        size: 123,
      },
    });
    const res = await probe.runProbe(asset.id);
    expect(res.durationSec).toBeNull();
    const refreshed = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(refreshed?.duration).toBeNull();
  });

  it('probe.runProbe is idempotent when duration already set', async () => {
    const asset = await prisma.mediaAsset.create({
      data: {
        key: `audio-done-${Date.now()}.mp3`,
        url: 'http://localhost:5000/a.mp3',
        contentType: 'audio/mpeg',
        size: 1000,
        duration: 42,
      },
    });
    const res = await probe.runProbe(asset.id);
    expect(res.durationSec).toBe(42);
    const refreshed = await prisma.mediaAsset.findUnique({ where: { id: asset.id } });
    expect(refreshed?.duration).toBe(42);
  });

  it('POST /admin/media/reprobe returns 202 with enqueued count', async () => {
    const res = await request(http())
      .post('/api/admin/media/reprobe')
      .set('Authorization', `Bearer ${adminAccess}`);
    expect([200, 202]).toContain(res.status);
    expect(typeof res.body.enqueued).toBe('number');
  });

  it('POST /admin/media/cleanup-orphans?dryRun=true returns candidates without deleting', async () => {
    const orphan = await prisma.mediaAsset.create({
      data: {
        key: `orphan-${Date.now()}.mp3`,
        url: 'http://localhost:5000/o.mp3',
        contentType: 'audio/mpeg',
        size: 1,
        createdAt: new Date(Date.now() - 10 * 86400 * 1000),
      },
    });
    const res = await request(http())
      .post('/api/admin/media/cleanup-orphans?dryRun=true&softDays=7&hardDays=30')
      .set('Authorization', `Bearer ${adminAccess}`);
    expect(res.status).toBe(200);
    expect(res.body.softDeletedCandidates).toEqual(expect.arrayContaining([orphan.id]));
    const stillThere = await prisma.mediaAsset.findUnique({ where: { id: orphan.id } });
    expect(stillThere?.isDeleted).toBe(false);
  });

  it('cleanup.cleanup soft-deletes old orphans and hard-deletes expired soft-deleted assets', async () => {
    // Soft candidate: orphan >7d old
    const softCandidate = await prisma.mediaAsset.create({
      data: {
        key: `soft-${Date.now()}.mp3`,
        url: 'http://localhost:5000/s.mp3',
        contentType: 'audio/mpeg',
        size: 1,
        createdAt: new Date(Date.now() - 10 * 86400 * 1000),
      },
    });
    // Hard candidate: soft-deleted >30d ago
    const hardCandidate = await prisma.mediaAsset.create({
      data: {
        key: `hard-${Date.now()}.mp3`,
        url: 'http://localhost:5000/h.mp3',
        contentType: 'audio/mpeg',
        size: 1,
        isDeleted: true,
        deletedAt: new Date(Date.now() - 40 * 86400 * 1000),
      },
    });

    const res = await cleanup.cleanup({ softDays: 7, hardDays: 30, dryRun: false });
    expect(res.markedSoftDeleted).toBeGreaterThanOrEqual(1);
    expect(res.hardDeleted).toBeGreaterThanOrEqual(1);

    const afterSoft = await prisma.mediaAsset.findUnique({ where: { id: softCandidate.id } });
    expect(afterSoft?.isDeleted).toBe(true);
    expect(afterSoft?.deletedAt).toBeInstanceOf(Date);

    const afterHard = await prisma.mediaAsset.findUnique({ where: { id: hardCandidate.id } });
    expect(afterHard).toBeNull();
  });

  it('cleanup does not touch MediaAssets that are referenced by AudioChapter or BookVersion.previewMediaId', async () => {
    const media = await prisma.mediaAsset.create({
      data: {
        key: `ref-${Date.now()}.mp3`,
        url: 'http://localhost:5000/r.mp3',
        contentType: 'audio/mpeg',
        size: 1,
        createdAt: new Date(Date.now() - 10 * 86400 * 1000),
      },
    });
    const book = await prisma.book.create({ data: { slug: `book-refs-${Date.now()}` } });
    const version = await prisma.bookVersion.create({
      data: {
        bookId: book.id,
        language: 'en',
        title: 'T',
        author: 'A',
        description: 'D',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'audio',
        isFree: true,
        previewMediaId: media.id,
      },
    });

    const res = await cleanup.cleanup({ softDays: 7, hardDays: 30, dryRun: true });
    expect(res.softDeletedCandidates ?? []).not.toContain(media.id);

    // cleanup
    await prisma.bookVersion.delete({ where: { id: version.id } });
    await prisma.book.delete({ where: { id: book.id } });
    await prisma.mediaAsset.delete({ where: { id: media.id } });
  });
});
