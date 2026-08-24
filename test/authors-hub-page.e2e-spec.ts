import request from 'supertest';
import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { Language } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { httpServerOf } from './http-server';

/**
 * Системная страница `authors-hub` заводится миграцией, а не админкой:
 * `Page.systemKey` редактору недоступен, в DTO его нет.
 *
 * 🔴 Проверяется именно резолв по ключу. Наличие строки в базе ничего не значит,
 * если `GET /:lang/pages/by-key/authors-hub` её не отдаёт: хаб тогда молча уйдёт
 * на словарные строки, а `SystemPagesService` будет писать `UNRESOLVED` в лог.
 */
describe('Authors hub CMS page (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleFixture.createNestApplication();
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const LANGS = [Language.en, Language.es, Language.fr, Language.pt, Language.ru];

  it('exists once per language, published, with the immutable key', async () => {
    const pages = await prisma.page.findMany({ where: { systemKey: 'authors-hub' } });

    expect(pages).toHaveLength(LANGS.length);
    for (const lang of LANGS) {
      const page = pages.find((p) => p.language === lang);
      expect(page).toBeDefined();
      expect(page!.status).toBe('published');
      expect(page!.type).toBe('author_index');
    }
  });

  it('resolves by key in every language and carries the editorial content', async () => {
    for (const lang of LANGS) {
      const res = await request(httpServerOf(app))
        .get(`/${lang}/pages/by-key/authors-hub`)
        .expect(200);

      const body = res.body as {
        language: string;
        h1: string;
        shortDescription: string;
        content: string;
        faq: Array<{ question: string; answer: string }>;
        seo: { metaTitle: string; metaDescription: string } | null;
      };

      // Публичный резолвер умеет отдать чужой язык — сверяем поле, а не код 200.
      expect(body.language).toBe(lang);
      expect(body.h1.length).toBeGreaterThan(0);
      expect(body.shortDescription.length).toBeGreaterThan(0);
      expect(body.content).toContain('<p>');
      expect(body.faq).toHaveLength(3);
      body.faq.forEach((item) => {
        expect(item.question.length).toBeGreaterThan(0);
        expect(item.answer.length).toBeGreaterThan(0);
      });
      expect(body.seo?.metaTitle).toContain('Bibliaris');
      expect(body.seo?.metaDescription.length).toBeGreaterThan(0);
    }
  });

  // Тексты пяти языков обязаны отличаться: копия английского на всех — это
  // ровно то, что `translation-rules.md` называет непереведённой строкой.
  it('carries a distinct text per language, not one copied five times', async () => {
    const pages = await prisma.page.findMany({ where: { systemKey: 'authors-hub' } });
    const contents = new Set(pages.map((p) => p.content));
    const h1s = new Set(pages.map((p) => p.h1));

    expect(contents.size).toBe(LANGS.length);
    // `Autores` совпадает у es и pt — это правда, а не недосмотр.
    expect(h1s.size).toBeGreaterThanOrEqual(4);
  });

  it('links the five rows as translations of one page', async () => {
    const pages = await prisma.page.findMany({ where: { systemKey: 'authors-hub' } });
    const groups = new Set(pages.map((p) => p.translationGroupId));

    expect(groups.size).toBe(1);
    expect([...groups][0]).toBeTruthy();
  });
});
