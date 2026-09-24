import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import {
  findMediaReferenceDescriptors,
  findStringReferencedKeys,
} from '../src/modules/media/media-references';

/**
 * 🔴 `LEGACY-421`. Json-колонки ищутся сырым `col::text LIKE`, а юнит видит только мок
 * `$queryRaw`. Здесь проверяется на живом Postgres, что каждый запрос перечня разбирается
 * (таблица и колонка существуют), что ключ внутри Json и внутри HTML находится, а `_` и `%`
 * в ключе ищутся буквально, а не как шаблон.
 */
describe('LEGACY-421 — ссылки на медиа внутри HTML и Json (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const slug = `e2e-media-json-${stamp}`;
  const jsonKey = `e2e-json-${stamp}/hero_image.webp`;
  const htmlKey = `e2e-html-${stamp}/inline.webp`;
  // Ключ, который R2 кодирует в адресе (`encodeKeyPath`): в тексте лежит только закодированный вид.
  const oddKey = `e2e-odd-${stamp}/обложка 1.jpg`;
  const oddUrl = `https://cdn.example/${encodeURI(oddKey)}`;

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();
    await prisma.page.create({
      data: {
        slug,
        title: 'Media refs',
        type: 'generic',
        language: 'en',
        content: `<p>Text</p><img src="https://cdn.example/${htmlKey}"><img src="${oddUrl}">`,
        sections: { hero: { image: `https://cdn.example/${jsonKey}` }, alt: oddUrl },
      },
    });
  });

  afterAll(async () => {
    await prisma?.page.deleteMany({ where: { slug } });
    await moduleRef?.close();
  });

  it('finds keys inside Page.sections Json and Page.content HTML, and runs every column query', async () => {
    const orphan = `e2e-orphan-${stamp}/x.webp`;
    const referenced = await findStringReferencedKeys(prisma, [jsonKey, htmlKey, orphan]);
    expect([...referenced].sort()).toEqual([htmlKey, jsonKey].sort());
  });

  it('finds a key whose address is percent-encoded, in HTML and in Json', async () => {
    expect(oddUrl).not.toContain(oddKey);
    expect([...(await findStringReferencedKeys(prisma, [oddKey]))]).toEqual([oddKey]);
    const page = await prisma.page.findFirstOrThrow({ where: { slug }, select: { id: true } });
    const references = await findMediaReferenceDescriptors(prisma, { id: 'none', key: oddKey });
    expect(references.sort()).toEqual([`Page.content (${page.id})`, `Page.sections (${page.id})`]);
  });

  it('treats `_` and `%` in a key literally', async () => {
    const lookalike = `e2e-json-${stamp}/heroXimage.webp`;
    const wildcard = `e2e-json-${stamp}/%`;
    const referenced = await findStringReferencedKeys(prisma, [lookalike, wildcard]);
    expect([...referenced]).toEqual([]);
  });

  it('refuses a manual delete of an image used only inside Json', async () => {
    const page = await prisma.page.findFirstOrThrow({ where: { slug }, select: { id: true } });
    const references = await findMediaReferenceDescriptors(prisma, { id: 'none', key: jsonKey });
    expect(references).toEqual([`Page.sections (${page.id})`]);
  });
});
