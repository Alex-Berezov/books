/* eslint-disable @typescript-eslint/no-unsafe-member-access -- тело ответа supertest типизировано как any */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { BookType, Language, RightsPublicationGate } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { grantStaffRoles } from './helpers/staff-roles';

/**
 * Решение владельца 27.09.2026 (тема №4): «Разрешить публикацию» — последняя инстанция по правам.
 * Администратор снимает с книги правовые блокеры гейта; контент-менеджеру кнопка недоступна;
 * отмена решения возвращает блокеры на место.
 */
describe('Rights publication override (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let adminToken: string;
  let managerToken: string;
  let bookId: string;
  let versionId: string;
  const slug = `override-${Date.now()}`;
  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  const registerOrLogin = async (email: string): Promise<{ token: string; userId: string }> => {
    const password = 'password123';
    const reg = await request(http()).post('/auth/register').send({ email, password });
    if (reg.status === 201) {
      return { token: reg.body.accessToken as string, userId: reg.body.user.id as string };
    }
    const login = await request(http()).post('/auth/login').send({ email, password }).expect(200);
    return { token: login.body.accessToken as string, userId: login.body.user.id as string };
  };

  const gate = () =>
    request(http())
      .get(`/admin/versions/${versionId}/publication-gate`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

    adminToken = (await registerOrLogin('admin-override@example.com')).token;
    await grantStaffRoles(app, 'admin-override@example.com');
    const manager = await registerOrLogin(`manager-override-${Date.now()}@example.com`);
    managerToken = manager.token;
    await request(http())
      .post(`/users/${manager.userId}/roles/content_manager`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(201);

    // Книга, которую ИИ-проверка «на всякий случай» закрыла вердиктом BLOCK.
    const rights = await createBookWithRights(prisma, slug);
    bookId = rights.book.id;
    await prisma.rightsProfile.update({
      where: { id: rights.profile.id },
      data: { publicationGate: RightsPublicationGate.BLOCK },
    });

    const created = await request(http())
      .post(`/books/${bookId}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Override Test EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
      })
      .expect(201);
    versionId = created.body.id as string;
  });

  afterAll(async () => {
    await cleanupBookWithRights(prisma, slug);
    await app.close();
  });

  it('blocks the version before any decision', async () => {
    const res = await gate();

    expect(res.body.canPublish).toBe(false);
    expect(res.body.supervisorOverride).toBeNull();
    expect(
      (res.body.blockingReasons as Array<{ code: string }>).some(
        (r) => r.code === 'PUBLICATION_GATE_BLOCK',
      ),
    ).toBe(true);
  });

  it('refuses the button to a content manager', async () => {
    await request(http())
      .post(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${managerToken}`)
      .send({ reasonRu: 'Книга в общественном достоянии.' })
      .expect(403);
  });

  it('requires a reason', async () => {
    await request(http())
      .post(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonRu: '   коротко ' })
      .expect(400);
  });

  it('lets an admin lift the block and publish', async () => {
    const granted = await request(http())
      .post(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonRu: 'Книга в общественном достоянии, проверка перестраховалась.' })
      .expect(201);

    expect(granted.body.bookId).toBe(bookId);
    expect(granted.body.bookSlug).toBe(slug);
    expect(granted.body.grantedByEmail).toBe('admin-override@example.com');
    expect(granted.body.revokedAt).toBeNull();

    const res = await gate();
    expect(res.body.canPublish).toBe(true);
    expect(res.body.supervisorOverride.id).toBe(granted.body.id);
    expect(
      (res.body.warnings as Array<{ code: string }>).some(
        (r) => r.code === 'SUPERVISOR_OVERRIDE_APPLIED',
      ),
    ).toBe(true);

    await request(http())
      .patch(`/versions/${versionId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    await request(http())
      .patch(`/versions/${versionId}/unpublish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
  });

  it('shows the decision to a content manager', async () => {
    const state = await request(http())
      .get(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${managerToken}`)
      .expect(200);

    expect(state.body.active.reasonRu).toBe(
      'Книга в общественном достоянии, проверка перестраховалась.',
    );
    expect(state.body.history).toHaveLength(1);
  });

  it('pressing again replaces the active decision instead of stacking a second one', async () => {
    await request(http())
      .post(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonRu: 'Повторное решение после новой претензии.' })
      .expect(201);

    const state = await request(http())
      .get(`/admin/books/${bookId}/rights-override`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const history = state.body.history as Array<{ revokedAt: string | null }>;

    expect(history).toHaveLength(2);
    expect(history.filter((item) => item.revokedAt === null)).toHaveLength(1);
    expect(state.body.active.reasonRu).toBe('Повторное решение после новой претензии.');
  });

  it('revoking puts the block back, and there is nothing left to revoke', async () => {
    await request(http())
      .post(`/admin/books/${bookId}/rights-override/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ reasonRu: 'Ошибся книгой.' })
      .expect(200);

    const res = await gate();
    expect(res.body.canPublish).toBe(false);
    expect(res.body.supervisorOverride).toBeNull();

    const again = await request(http())
      .post(`/admin/books/${bookId}/rights-override/revoke`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({})
      .expect(409);
    expect(again.body.code).toBe('RIGHTS_OVERRIDE_NOT_ACTIVE');
  });
});
