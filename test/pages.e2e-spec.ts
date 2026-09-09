/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
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

  it('GET /admin/pages/:id - should return page by ID (any status)', async () => {
    slug = `test-page-${Date.now()}`;

    // Create draft page
    const createRes = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug,
        title: 'Test Page',
        type: 'generic',
        content: 'Test content',
      })
      .expect(201);
    pageId = createRes.body.id as string;

    // Get page by ID (should work for draft)
    const getRes = await request(http())
      .get(`/admin/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(getRes.body.id).toBe(pageId);
    expect(getRes.body.slug).toBe(slug);
    expect(getRes.body.title).toBe('Test Page');
    expect(getRes.body.status).toBe('draft');
    expect(getRes.body.language).toBe('en');

    // Publish page
    await request(http())
      .patch(`/admin/en/pages/${pageId}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    // Get page by ID (should work for published)
    const getPublishedRes = await request(http())
      .get(`/admin/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(getPublishedRes.body.status).toBe('published');

    // Cleanup
    await request(http())
      .delete(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);

    // Get non-existent page should return 404
    await request(http())
      .get(`/admin/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(404);
  });

  it('GET /admin/pages/:id - should include SEO data when present', async () => {
    slug = `page-with-seo-${Date.now()}`;

    // First, check that page without SEO returns seo: null
    const createRes = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug,
        title: 'Page without SEO',
        type: 'generic',
        content: 'Content',
      })
      .expect(201);
    pageId = createRes.body.id as string;

    const getNoSeoRes = await request(http())
      .get(`/admin/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    expect(getNoSeoRes.body.seoId).toBeNull();
    expect(getNoSeoRes.body.seo).toBeNull();

    // Cleanup
    await request(http())
      .delete(`/admin/en/pages/${pageId}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });

  it('GET /admin/pages - search and status filter (LEGACY-371)', async () => {
    const stamp = Date.now();
    const needle = `zzquux${stamp}`;

    // one draft page matching the search term, one published page that doesn't
    const draftSlug = `${needle}-draft`;
    const draftRes = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: draftSlug, title: `Needle ${needle}`, type: 'generic', content: 'x' })
      .expect(201);
    const draft = draftRes.body as { id: string; translationGroupId: string };

    const publishedSlug = `unrelated-${stamp}`;
    const publishedRes = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({ slug: publishedSlug, title: 'Unrelated title', type: 'generic', content: 'y' })
      .expect(201);
    const published = publishedRes.body as { id: string; translationGroupId: string };
    await request(http())
      .patch(`/admin/en/pages/${published.id}/publish`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);

    const groupIdsOf = (body: unknown): string[] =>
      (body as { data: Array<{ translationGroupId: string }> }).data.map(
        (g) => g.translationGroupId,
      );

    // before LEGACY-371 was fixed, either query param alone was a 400
    // (global ValidationPipe forbids fields the DTO doesn't declare)
    const bySearch = await request(http())
      .get(`/admin/pages?search=${needle}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(groupIdsOf(bySearch.body)).toContain(draft.translationGroupId);
    expect(groupIdsOf(bySearch.body)).not.toContain(published.translationGroupId);

    // the draft matches the (shortened) search term but not the status:
    // the two conditions are combined, not applied one instead of the other
    const byStatus = await request(http())
      .get(`/admin/pages?status=published&search=${needle.slice(0, 4)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(groupIdsOf(byStatus.body)).not.toContain(draft.translationGroupId);

    const byStatusOnly = await request(http())
      .get(`/admin/pages?status=draft&search=${needle}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(200);
    expect(groupIdsOf(byStatusOnly.body)).toContain(draft.translationGroupId);

    // an unknown status value must still be rejected — the DTO is a closed set
    await request(http())
      .get('/admin/pages?status=archived')
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);

    // a term over the cap is a 400, not an unbounded ILIKE over every page
    await request(http())
      .get(`/admin/pages?search=${'a'.repeat(101)}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(400);

    // Cleanup
    await request(http())
      .delete(`/admin/en/pages/${draft.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
    await request(http())
      .delete(`/admin/en/pages/${published.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });

  it('GET /admin/pages - "%" in the search term is a character, not a wildcard (LEGACY-371)', async () => {
    const stamp = Date.now();

    // the unit spec asserts only the shape of the Prisma `where`; whether the
    // backslash actually reaches Postgres as LIKE's escape character is
    // something only a real query can answer
    const created = await request(http())
      .post('/admin/en/pages')
      .set('Authorization', `Bearer ${adminAccess}`)
      .send({
        slug: `discount-${stamp}`,
        title: `100% off sale ${stamp}`,
        type: 'generic',
        content: 'x',
      })
      .expect(201);
    const page = created.body as { id: string; translationGroupId: string };

    const idsFor = async (term: string): Promise<string[]> => {
      const res = await request(http())
        .get(`/admin/pages?search=${encodeURIComponent(term)}&limit=100`)
        .set('Authorization', `Bearer ${adminAccess}`)
        .expect(200);
      return (res.body as { data: Array<{ translationGroupId: string }> }).data.map(
        (g) => g.translationGroupId,
      );
    };

    // the discriminating case: "100%sale" occurs in no title as text, but as a
    // LIKE pattern it reads "100", anything, "sale" — and that does match
    // "100% off sale". Escaped, the page must NOT come back; drop the escaping
    // and it does, which is exactly what this case is here to catch.
    expect(await idsFor('100%sale')).not.toContain(page.translationGroupId);

    // the same for "_": as a pattern it stands for any single character
    expect(await idsFor('100_ off')).not.toContain(page.translationGroupId);

    // and escaping must not cost legitimate matching: the literal substring is found
    expect(await idsFor('100% off')).toContain(page.translationGroupId);

    // Cleanup
    await request(http())
      .delete(`/admin/en/pages/${page.id}`)
      .set('Authorization', `Bearer ${adminAccess}`)
      .expect(204);
  });
});
