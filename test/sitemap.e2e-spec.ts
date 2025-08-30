import * as request from 'supertest';
import { App } from 'supertest/types';
import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import { AppModule } from '../src/app.module';

describe('Sitemap & Robots (e2e)', () => {
  let app: INestApplication<App>;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /sitemap.xml returns sitemap index', async () => {
    const res = await request(app.getHttpServer()).get('/sitemap.xml').expect(200);
    expect(res.header['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<sitemapindex');
  });

  it('GET /robots.txt returns robots', async () => {
    const res = await request(app.getHttpServer()).get('/robots.txt').expect(200);
    expect(res.header['content-type']).toMatch(/text\/plain/);
    expect(res.text).toContain('Sitemap:');
  });

  it('GET /sitemap-en.xml returns urlset', async () => {
    const res = await request(app.getHttpServer()).get('/sitemap-en.xml').expect(200);
    expect(res.header['content-type']).toMatch(/application\/xml/);
    expect(res.text).toContain('<urlset');
  });
});
