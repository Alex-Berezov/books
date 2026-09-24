import { PrismaService } from '../../prisma/prisma.service';

/** Строка, чей адрес содержит один из ключей: `url` — само значение колонки. */
export interface MediaUrlReferenceRow {
  id: string | number;
  title?: string;
  url: string | null;
}

/**
 * Одна колонка, в которой может лежать адрес или ключ медиа.
 *
 * `find` ищет на стороне базы строки, чей адрес содержит **любой** из ключей, — таблица
 * в память не читается, объём ответа ограничен совпадениями. Доступ к модели идёт
 * типизированным вызовом, а не по имени делегата: обращение к клиенту по строке запрещено
 * правилом B01.
 */
export interface MediaUrlColumn {
  field: string;
  describe: (row: MediaUrlReferenceRow) => string;
  find: (prisma: PrismaService, keys: string[], take?: number) => Promise<MediaUrlReferenceRow[]>;
}

/**
 * 🔴 Единственный перечень колонок, где может лежать адрес или ключ медиа (LEGACY-413).
 *
 * Сюда входит **каждая** строковая колонка-адрес или колонка-ключ, которую пишет оператор,
 * а не только те, что по смыслу «про картинки»: ни одна из них не проверяет, что внутри
 * внешний адрес, и ссылка из медиатеки, вставленная в поле документа лицензии, делает файл
 * живым. Исключения — только собственный адрес ассета, идентификаторы записей и ключи
 * приватного хранилища прав, которые пишет сервер; их перечень с причинами лежит в сторож-спеке
 * `media-references.spec.ts`, и он сверяет оба списка со схемой через `Prisma.dmmf`.
 *
 * Поля-тексты (HTML редактора) и Json ищутся не здесь, а SQL-поиском по таблицам
 * `media-text-columns.ts` и `media-json-columns.ts` (`LEGACY-421`).
 */
export const MEDIA_URL_COLUMNS: readonly MediaUrlColumn[] = [
  {
    field: 'BookVersion.coverImageUrl',
    describe: (row) => `book version "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.bookVersion.findMany({
          where: { OR: keys.map((key) => ({ coverImageUrl: { contains: key } })) },
          select: { id: true, title: true, coverImageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.coverImageUrl })),
  },
  {
    field: 'AudioChapter.audioUrl',
    describe: (row) => `audio chapter "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.audioChapter.findMany({
          where: { OR: keys.map((key) => ({ audioUrl: { contains: key } })) },
          select: { id: true, title: true, audioUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.audioUrl })),
  },
  {
    field: 'User.avatarUrl',
    describe: (row) => `user avatar (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.user.findMany({
          where: { OR: keys.map((key) => ({ avatarUrl: { contains: key } })) },
          select: { id: true, avatarUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.avatarUrl })),
  },
  {
    field: 'AuthorTranslation.photoUrl',
    describe: (row) => `author photo (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.authorTranslation.findMany({
          where: { OR: keys.map((key) => ({ photoUrl: { contains: key } })) },
          select: { id: true, photoUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.photoUrl })),
  },
  {
    field: 'PersonTranslation.photoUrl',
    describe: (row) => `person photo (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.personTranslation.findMany({
          where: { OR: keys.map((key) => ({ photoUrl: { contains: key } })) },
          select: { id: true, photoUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.photoUrl })),
  },
  {
    field: 'Seo.ogImageUrl',
    describe: (row) => `seo og:image (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.seo.findMany({
          where: { OR: keys.map((key) => ({ ogImageUrl: { contains: key } })) },
          select: { id: true, ogImageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.ogImageUrl })),
  },
  {
    field: 'Seo.eventImageUrl',
    describe: (row) => `seo event image (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.seo.findMany({
          where: { OR: keys.map((key) => ({ eventImageUrl: { contains: key } })) },
          select: { id: true, eventImageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.eventImageUrl })),
  },
  {
    field: 'CategoryTranslation.ogImageUrl',
    describe: (row) => `category og:image (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.categoryTranslation.findMany({
          where: { OR: keys.map((key) => ({ ogImageUrl: { contains: key } })) },
          select: { id: true, ogImageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.ogImageUrl })),
  },
  {
    field: 'TagTranslation.ogImageUrl',
    describe: (row) => `tag og:image (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.tagTranslation.findMany({
          where: { OR: keys.map((key) => ({ ogImageUrl: { contains: key } })) },
          select: { id: true, ogImageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.ogImageUrl })),
  },
  {
    field: 'BookVersion.referralUrl',
    describe: (row) => `book version referral link "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.bookVersion.findMany({
          where: { OR: keys.map((key) => ({ referralUrl: { contains: key } })) },
          select: { id: true, title: true, referralUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.referralUrl })),
  },
  {
    field: 'BookVersion.authorPageUrl',
    describe: (row) => `book version author page link "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.bookVersion.findMany({
          where: { OR: keys.map((key) => ({ authorPageUrl: { contains: key } })) },
          select: { id: true, title: true, authorPageUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.authorPageUrl })),
  },
  {
    field: 'Seo.canonicalUrl',
    describe: (row) => `seo canonical url (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.seo.findMany({
          where: { OR: keys.map((key) => ({ canonicalUrl: { contains: key } })) },
          select: { id: true, canonicalUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.canonicalUrl })),
  },
  {
    field: 'Seo.ogUrl',
    describe: (row) => `seo og:url (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.seo.findMany({
          where: { OR: keys.map((key) => ({ ogUrl: { contains: key } })) },
          select: { id: true, ogUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.ogUrl })),
  },
  {
    field: 'Seo.eventUrl',
    describe: (row) => `seo event url (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.seo.findMany({
          where: { OR: keys.map((key) => ({ eventUrl: { contains: key } })) },
          select: { id: true, eventUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.eventUrl })),
  },
  {
    field: 'TagTranslation.canonicalUrl',
    describe: (row) => `tag canonical url (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.tagTranslation.findMany({
          where: { OR: keys.map((key) => ({ canonicalUrl: { contains: key } })) },
          select: { id: true, canonicalUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.canonicalUrl })),
  },
  {
    field: 'AuthorTranslation.wikidataUrl',
    describe: (row) => `author wikidata link (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.authorTranslation.findMany({
          where: { OR: keys.map((key) => ({ wikidataUrl: { contains: key } })) },
          select: { id: true, wikidataUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.wikidataUrl })),
  },
  {
    field: 'AuthorTranslation.wikipediaUrl',
    describe: (row) => `author wikipedia link (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.authorTranslation.findMany({
          where: { OR: keys.map((key) => ({ wikipediaUrl: { contains: key } })) },
          select: { id: true, wikipediaUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.wikipediaUrl })),
  },
  {
    field: 'PersonTranslation.wikidataUrl',
    describe: (row) => `person wikidata link (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.personTranslation.findMany({
          where: { OR: keys.map((key) => ({ wikidataUrl: { contains: key } })) },
          select: { id: true, wikidataUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.wikidataUrl })),
  },
  {
    field: 'PersonTranslation.wikipediaUrl',
    describe: (row) => `person wikipedia link (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.personTranslation.findMany({
          where: { OR: keys.map((key) => ({ wikipediaUrl: { contains: key } })) },
          select: { id: true, wikipediaUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.wikipediaUrl })),
  },
  {
    field: 'RightsIntake.sourceUrl',
    describe: (row) => `rights intake source (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsIntake.findMany({
          where: { OR: keys.map((key) => ({ sourceUrl: { contains: key } })) },
          select: { id: true, sourceUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.sourceUrl })),
  },
  {
    field: 'SourceEdition.sourceUrl',
    describe: (row) => `source edition (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.sourceEdition.findMany({
          where: { OR: keys.map((key) => ({ sourceUrl: { contains: key } })) },
          select: { id: true, sourceUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.sourceUrl })),
  },
  {
    field: 'RightsLegalChangeEvent.sourceUrl',
    describe: (row) => `legal change source (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsLegalChangeEvent.findMany({
          where: { OR: keys.map((key) => ({ sourceUrl: { contains: key } })) },
          select: { id: true, sourceUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.sourceUrl })),
  },
  {
    field: 'RightsEvidence.url',
    describe: (row) => `rights evidence (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsEvidence.findMany({
          where: { OR: keys.map((key) => ({ url: { contains: key } })) },
          select: { id: true, url: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.url })),
  },
  {
    field: 'RightsLicense.documentUrl',
    describe: (row) => `rights license document url (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsLicense.findMany({
          where: { OR: keys.map((key) => ({ documentUrl: { contains: key } })) },
          select: { id: true, documentUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.documentUrl })),
  },
  {
    field: 'RightsLicense.documentStorageKey',
    describe: (row) => `rights license document key (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsLicense.findMany({
          where: { OR: keys.map((key) => ({ documentStorageKey: { contains: key } })) },
          select: { id: true, documentStorageKey: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.documentStorageKey })),
  },
  {
    field: 'RightsLegalOpinion.documentUrl',
    describe: (row) => `legal opinion document (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsLegalOpinion.findMany({
          where: { OR: keys.map((key) => ({ documentUrl: { contains: key } })) },
          select: { id: true, documentUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.documentUrl })),
  },
  {
    field: 'RightsClaim.originalNoticeUrl',
    describe: (row) => `rights claim notice (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsClaim.findMany({
          where: { OR: keys.map((key) => ({ originalNoticeUrl: { contains: key } })) },
          select: { id: true, originalNoticeUrl: true },
          take,
        })
      ).map((row) => ({ id: row.id, url: row.originalNoticeUrl })),
  },
  {
    field: 'RightsClaimAttachment.url',
    describe: (row) => `rights claim attachment url "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsClaimAttachment.findMany({
          where: { OR: keys.map((key) => ({ url: { contains: key } })) },
          select: { id: true, title: true, url: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.url })),
  },
  {
    field: 'RightsClaimAttachment.storageKey',
    describe: (row) => `rights claim attachment key "${row.title}" (${row.id})`,
    find: async (prisma, keys, take) =>
      (
        await prisma.rightsClaimAttachment.findMany({
          where: { OR: keys.map((key) => ({ storageKey: { contains: key } })) },
          select: { id: true, title: true, storageKey: true },
          take,
        })
      ).map((row) => ({ id: row.id, title: row.title, url: row.storageKey })),
  },
];
