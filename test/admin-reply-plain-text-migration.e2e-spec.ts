import { readFileSync } from 'fs';
import { join } from 'path';
import { Test, TestingModule } from '@nestjs/testing';
import { Language, RoleName } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';
import { createBookFixture } from './helpers/book-fixture';

const MIGRATION = join(
  __dirname,
  '../prisma/migrations/20261001120000_legacy_429_admin_reply_plain_text/migration.sql',
);

/** Операторы миграции по одному: Prisma не исполняет несколько команд одним вызовом. */
const statements = (): string[] =>
  readFileSync(MIGRATION, 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .split(/;\s*$/m)
    .map((sql) => sql.trim())
    .filter(Boolean);

/**
 * 🔴 `LEGACY-429`, решение арбитра T79. До T47 ответ администратора сохранялся HTML-строкой,
 * и читатель видел теги. Миграция копирует исходный текст в резервную таблицу и снимает
 * разметку только у ответов модератора, записанных до выката T47; здесь её SQL исполняется
 * на живом Postgres по строкам, которые оставил старый путь.
 */
describe('LEGACY-429 — снятие HTML со старых ответов администратора (e2e)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  const stamp = Date.now();
  const before = new Date('2026-09-20T10:00:00Z');
  const after = new Date('2026-09-29T10:00:00Z');
  const html =
    '<p>Спасибо за <strong>отзыв</strong>!</p><p>Рекомендуем:<br>главу&nbsp;2 &amp; 3, ' +
    '&lt;не&gt; &quot;пропустите&quot; &#39;финал&#39;, &amp;lt;код&amp;gt;</p>' +
    '<ul><li>один</li><li><a href="https://x.example">два</a></li></ul>';
  const plain =
    'Спасибо за отзыв!\nРекомендуем:\nглаву 2 & 3, <не> "пропустите" \'финал\', ' +
    '&lt;код&gt;\nодин\nдва (https://x.example)';
  const managerHtml =
    '<pre><code>x = 1</code></pre><blockquote><p>цитата</p></blockquote><hr>' +
    '<P>Конец&#x27;s &apos;ok&apos; &#34;q&#34;</P>';
  const linksHtml =
    '<p>См. <a href="https://x.example/guide" target="_blank">гайд</a> и ' +
    '<a href="https://x.example">https://x.example</a></p><p><img src="https://cdn.example/i.png" alt="i"></p>';
  const nestedHtml =
    '<ul><li><p>один</p></li><li><p><a href="https://x.example/a"><strong>жирная</strong> ссылка</a></p></li></ul>';
  const imgLinkHtml =
    '<p><a href="https://cdn.example/full.png"><img src="https://cdn.example/thumb.png"></a></p>';
  const typedText = 'пишите <br> для переноса, Tom &amp; Jerry';
  const ids: Record<string, string> = {};
  const userIds: string[] = [];
  let bookId = '';

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    prisma = moduleRef.get(PrismaService);
    await moduleRef.init();

    const adminRole = await prisma.role.upsert({
      where: { name: RoleName.admin },
      update: {},
      create: { name: RoleName.admin },
    });
    const makeUser = async (tag: string) => {
      const user = await prisma.user.create({
        data: { email: `l429-${tag}-${stamp}@ex.com`, languagePreference: Language.en },
      });
      userIds.push(user.id);
      return user.id;
    };
    const admin = await makeUser('admin');
    await prisma.userRole.create({ data: { userId: admin, roleId: adminRole.id } });
    const reader = await makeUser('reader');
    // Живой читатель несёт базовую роль `user`: граница миграции — роль модератора, а не
    // наличие роли вообще.
    const userRole = await prisma.role.upsert({
      where: { name: RoleName.user },
      update: {},
      create: { name: RoleName.user },
    });
    await prisma.userRole.create({ data: { userId: reader, roleId: userRole.id } });
    // Модератор — не только `admin`: тот же набор, что `ModeratorRolesService.isModerator`.
    const managerRole = await prisma.role.upsert({
      where: { name: RoleName.content_manager },
      update: {},
      create: { name: RoleName.content_manager },
    });
    const manager = await makeUser('manager');
    await prisma.userRole.create({ data: { userId: manager, roleId: managerRole.id } });

    const book = await createBookFixture(prisma, `l429-${stamp}`);
    bookId = book.id;
    const version = await prisma.bookVersion.create({
      data: {
        bookId,
        language: 'en',
        title: 't',
        author: 'a',
        description: 'd',
        coverImageUrl: 'https://example.com/c.jpg',
        type: 'text',
        isFree: true,
      },
    });
    const comment = async (
      key: string,
      data: { userId: string; text: string; createdAt: Date; parentId?: string },
    ) => {
      const row = await prisma.comment.create({ data: { bookVersionId: version.id, ...data } });
      ids[key] = row.id;
      return row.id;
    };
    const root = await comment('readerRoot', {
      userId: reader,
      text: '<b>мой</b> отзыв',
      createdAt: before,
    });
    await comment('adminOld', { userId: admin, text: html, createdAt: before, parentId: root });
    await comment('adminNew', {
      userId: admin,
      text: '<p>после T47</p>',
      createdAt: after,
      parentId: root,
    });
    await comment('readerReply', {
      userId: reader,
      text: '<strong>жирно</strong>',
      createdAt: before,
      parentId: root,
    });
    await comment('adminRoot', { userId: admin, text: '<p>корень</p>', createdAt: before });
    await comment('adminPlain', {
      userId: admin,
      text: 'a < b',
      createdAt: before,
      parentId: root,
    });
    // Блоки без `<p>`, тег в верхнем регистре и сущности апострофа (набор `RICH_HTML_ALLOWED_TAGS`).
    await comment('managerOld', {
      userId: manager,
      text: managerHtml,
      createdAt: before,
      parentId: root,
    });
    // Адрес ссылки и картинки остаётся в тексте.
    await comment('adminLinks', {
      userId: admin,
      text: linksHtml,
      createdAt: before,
      parentId: root,
    });
    // Список из редактора (`<li><p>`) и ссылка со строчным тегом внутри.
    await comment('adminNested', {
      userId: admin,
      text: nestedHtml,
      createdAt: before,
      parentId: root,
    });
    await comment('adminQuote', {
      userId: admin,
      text: '<blockquote><p>цитата</p></blockquote><p>ответ</p>',
      createdAt: before,
      parentId: root,
    });
    // Ссылка вокруг картинки: оба адреса остаются в тексте.
    await comment('adminImgLink', {
      userId: admin,
      text: imgLinkHtml,
      createdAt: before,
      parentId: root,
    });
    // Простой текст модератора из публичной формы: `<br>` и `&amp;` набраны руками.
    await comment('managerTyped', {
      userId: manager,
      text: typedText,
      createdAt: before,
      parentId: root,
    });
    // Один блок кода, без тегов старого узкого набора.
    await comment('managerCode', {
      userId: manager,
      text: '<pre><code>a &lt; b</code></pre>',
      createdAt: before,
      parentId: root,
    });
    await comment('adminOnlyTags', {
      userId: admin,
      text: '<p></p>',
      createdAt: before,
      parentId: root,
    });
  });

  afterAll(async () => {
    const commentIds = Object.values(ids);
    await prisma?.legacy429CommentText.deleteMany({ where: { id: { in: commentIds } } });
    await prisma?.comment.deleteMany({ where: { parentId: { in: commentIds } } });
    await prisma?.comment.deleteMany({ where: { id: { in: commentIds } } });
    await prisma?.bookVersion.deleteMany({ where: { bookId } });
    await prisma?.book.deleteMany({ where: { id: bookId } });
    await prisma?.userRole.deleteMany({ where: { userId: { in: userIds } } });
    await prisma?.user.deleteMany({ where: { id: { in: userIds } } });
    await moduleRef?.close();
  });

  const textOf = async (key: string) =>
    (await prisma.comment.findUniqueOrThrow({ where: { id: ids[key] } })).text;

  it('снимает разметку у старого ответа админа, остальное не трогает; повтор безопасен', async () => {
    for (let run = 0; run < 2; run++) {
      for (const sql of statements()) await prisma.$executeRawUnsafe(sql);
    }

    expect(await textOf('adminOld')).toBe(plain);
    expect(await textOf('managerOld')).toBe(`x = 1\nцитата\n\nКонец's 'ok' "q"`);
    expect(await textOf('adminLinks')).toBe(
      'См. гайд (https://x.example/guide) и https://x.example\nhttps://cdn.example/i.png',
    );
    expect(await textOf('adminNested')).toBe('один\nжирная ссылка (https://x.example/a)');
    expect(await textOf('adminQuote')).toBe('цитата\nответ');
    expect(await textOf('adminImgLink')).toBe(
      '(https://cdn.example/full.png) https://cdn.example/thumb.png',
    );
    expect(await textOf('managerTyped')).toBe(typedText);
    expect(await textOf('managerCode')).toBe('a < b');
    expect(await textOf('adminNew')).toBe('<p>после T47</p>');
    expect(await textOf('readerReply')).toBe('<strong>жирно</strong>');
    expect(await textOf('readerRoot')).toBe('<b>мой</b> отзыв');
    expect(await textOf('adminRoot')).toBe('<p>корень</p>');
    expect(await textOf('adminPlain')).toBe('a < b');
    // Пустой итог не пишется: текст комментария обязателен.
    expect(await textOf('adminOnlyTags')).toBe('<p></p>');

    const backup = await prisma.legacy429CommentText.findMany({
      where: { id: { in: Object.values(ids) } },
    });
    expect(Object.fromEntries(backup.map((row) => [row.id, row.text]))).toEqual({
      [ids.adminOld]: html,
      [ids.managerOld]: managerHtml,
      [ids.adminLinks]: linksHtml,
      [ids.adminNested]: nestedHtml,
      [ids.adminImgLink]: imgLinkHtml,
      [ids.adminQuote]: '<blockquote><p>цитата</p></blockquote><p>ответ</p>',
      [ids.managerCode]: '<pre><code>a &lt; b</code></pre>',
      [ids.adminOnlyTags]: '<p></p>',
    });

    // Резервная таблица исключена из поиска медиа (`media-references.spec.ts`): каждый адрес
    // исходника обязан остаться в очищенном тексте, иначе уборка сочтёт файл ничьим.
    for (const row of backup) {
      const urls = [...row.text.matchAll(/(?:href|src)="([^"]*)"/g)].map((m) => m[1]);
      const cleaned = await prisma.comment.findUniqueOrThrow({ where: { id: row.id } });
      for (const url of urls) expect(cleaned.text).toContain(url);
    }
  });

  // Откат — только вперёд и только там, где текст равен очищенному (решение арбитра 01.10.2026):
  // ответ, отредактированный после выката, не затирается.
  it('откат из резервной таблицы возвращает HTML и не трогает правленый после выката текст', async () => {
    await prisma.comment.update({
      where: { id: ids.adminLinks },
      data: { text: 'правка после выката' },
    });
    const rollback = (id: string, cleaned: string) =>
      prisma.$executeRaw`UPDATE "Comment" c SET "text" = b."text" FROM "_legacy429_comment_text" b
        WHERE c."id" = b."id" AND c."id" = ${id} AND c."text" = ${cleaned}`;
    await rollback(ids.adminOld, plain);
    await rollback(
      ids.adminLinks,
      'См. гайд (https://x.example/guide) и https://x.example\nhttps://cdn.example/i.png',
    );
    expect(await textOf('adminOld')).toBe(html);
    expect(await textOf('adminLinks')).toBe('правка после выката');
  });
});
