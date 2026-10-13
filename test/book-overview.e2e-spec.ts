/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { Language, BookType } from '@prisma/client';
import { createBookWithRights, cleanupBookWithRights } from './helpers/book-with-rights';
import { markBookRightsFreshForTests } from './helpers/rights-fresh';
import { RightsContentHashService } from '../src/modules/rights-intake/rights-content-hash.service';
import { grantStaffRoles } from './helpers/staff-roles';

describe('Book Overview (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let rightsContentHashService: RightsContentHashService;
  let adminToken: string;
  let bookSlug: string;

  const http = (): import('http').Server => app.getHttpServer() as import('http').Server;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    rightsContentHashService = moduleRef.get(RightsContentHashService);
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
    );
    await app.init();

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
    await grantStaffRoles(app, email);
  });

  afterAll(async () => {
    if (bookSlug) {
      await cleanupBookWithRights(prisma, bookSlug);
    }
    await app.close();
  });

  it('returns aggregated overview with flags and SEO (published only)', async () => {
    bookSlug = `overview-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, bookSlug);

    // Create text EN (draft) with SEO
    const createText = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.en,
        title: 'Title EN',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover.jpg',
        type: BookType.text,
        isFree: true,
        seoMetaTitle: 'SEO Main EN',
        seoMetaDescription: 'SEO Desc EN',
      })
      .expect(201);
    const versionTextId = (createText.body as { id: string }).id;

    // Summary for text version
    await request(http())
      .put(`/versions/${versionTextId}/summary`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({ summary: 'Short summary' })
      .expect(200);

    // Create audio ES (draft)
    const createAudio = await request(http())
      .post(`/books/${bookWithRights.book.id}/versions`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        language: Language.es,
        title: 'Audio ES',
        author: 'Author',
        description: 'Desc',
        coverImageUrl: 'https://example.com/cover2.jpg',
        type: BookType.audio,
        isFree: false,
        seoMetaTitle: 'SEO Audio ES',
        seoMetaDescription: 'SEO Audio Desc ES',
      })
      .expect(201);
    const versionAudioId = (createAudio.body as { id: string }).id;

    // Create audio chapters for the audio version
    await request(http())
      .post(`/versions/${versionAudioId}/audio-chapters`)
      .set('Authorization', `Bearer ${adminToken}`)
      .send({
        number: 1,
        title: 'Audio Chapter 1',
        audioUrl: 'https://example.com/a/1.mp3',
        duration: 100,
      })
      .expect(201);

    // Reset rights status after content changes (this test doesn't check rights)
    await markBookRightsFreshForTests(prisma, bookWithRights.book.id, rightsContentHashService);

    // Publish only text
    await request(http())
      .patch(`/versions/${versionTextId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);

    // Overview should show only text-related flags as true
    const res1 = await request(http()).get(`/en/books/${bookSlug}/overview`).expect(200);
    expect(res1.body.book.slug).toBe(bookSlug);
    expect(res1.body.hasText).toBe(true);
    expect(res1.body.hasAudio).toBe(false);
    expect(res1.body.versionIds.text).toBe(versionTextId);
    expect(res1.body.versionIds.audio).toBeNull();
    // availableLanguages includes only languages of published versions
    expect(res1.body.availableLanguages).toEqual([Language.en]);
    // seo.main populated from text version
    expect(res1.body.seo.main.metaTitle).toBe('SEO Main EN');
    expect(res1.body.hasSummary).toBe(true);
    // F01-5: без переводчиков поле есть и пустое, а не null.
    expect(res1.body.versions[0].translators).toEqual([]);

    // Now publish audio and re-check
    await request(http())
      .patch(`/versions/${versionAudioId}/publish`)
      .set('Authorization', `Bearer ${adminToken}`)
      .expect(200);
    const res2 = await request(http()).get(`/es/books/${bookSlug}/overview`).expect(200);
    const langs = (res2.body.availableLanguages as string[]) || [];
    expect(new Set(langs)).toEqual(new Set([Language.en, Language.es]));
    expect(res2.body.hasAudio).toBe(true);
    expect(res2.body.versionIds.audio).toBe(versionAudioId);
    // lang=es prefers ES for audio SEO
    expect(res2.body.seo.listen.metaTitle).toBe('SEO Audio ES');
  });

  it('F01-5: отдаёт переводчиков версии только именем и только роли TRANSLATOR', async () => {
    const slug = `overview-tr-${Date.now()}`;
    const bookWithRights = await createBookWithRights(prisma, slug);
    const createdPersonIds: string[] = [];
    try {
      const created = await request(http())
        .post(`/books/${bookWithRights.book.id}/versions`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({
          language: Language.ru,
          title: 'Книга',
          author: 'Автор',
          description: 'Desc',
          coverImageUrl: 'https://example.com/cover.jpg',
          type: BookType.text,
          isFree: true,
        })
        .expect(201);
      const versionId = (created.body as { id: string }).id;
      await request(http())
        .put(`/versions/${versionId}/summary`)
        .set('Authorization', `Bearer ${adminToken}`)
        .send({ summary: 'Short summary' })
        .expect(200);

      const mkPerson = async (canonicalName: string, ruName?: string) => {
        const person = await prisma.person.create({
          data: {
            canonicalName,
            translations: ruName
              ? {
                  create: {
                    language: Language.ru,
                    slug: `${slug}-${createdPersonIds.length}`,
                    displayName: ruName,
                  },
                }
              : undefined,
          },
        });
        createdPersonIds.push(person.id);
        return person.id;
      };
      const second = await mkPerson('Second Translator');
      const first = await mkPerson('Constance Garnett', 'Констанс Гарнетт');
      const editor = await mkPerson('An Editor');
      await prisma.bookVersionContributor.createMany({
        data: [
          {
            bookVersionId: versionId,
            personId: second,
            role: 'TRANSLATOR',
            displayOrder: 2,
            contributionNoteRu: 'не для публики',
          },
          {
            bookVersionId: versionId,
            personId: first,
            role: 'TRANSLATOR',
            displayOrder: 1,
            creditedName: 'Credited As',
          },
          { bookVersionId: versionId, personId: editor, role: 'EDITOR', displayOrder: 0 },
        ],
      });
      await markBookRightsFreshForTests(prisma, bookWithRights.book.id, rightsContentHashService);
      await request(http())
        .patch(`/versions/${versionId}/publish`)
        .set('Authorization', `Bearer ${adminToken}`)
        .expect(200);

      const res = await request(http()).get(`/ru/books/${slug}/overview`).expect(200);
      const version = (res.body.versions as Record<string, unknown>[])[0];
      expect(version.translators).toEqual([
        { name: 'Констанс Гарнетт' },
        { name: 'Second Translator' },
      ]);
      expect(version).not.toHaveProperty('contributors');
      expect(JSON.stringify(res.body)).not.toContain('не для публики');
      expect(JSON.stringify(res.body)).not.toContain('Credited As');
    } finally {
      // Персоны чистятся первыми: упадёт уборка книги - они всё равно не останутся в общей базе e2e.
      await prisma.person.deleteMany({ where: { id: { in: createdPersonIds } } });
      await cleanupBookWithRights(prisma, slug);
    }
  });
});
