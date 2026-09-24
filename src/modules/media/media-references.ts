import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { MEDIA_URL_COLUMNS } from './media-url-columns';

/**
 * Кто ссылается на медиа-объект — внешним ключом или **строкой URL**.
 *
 * Внешних ключей на `MediaAsset` пять (`MEDIA_FOREIGN_KEYS` ниже), и все они
 * `onDelete: SetNull`: удаление ассета молча обнуляет ссылку, а не отказывает. Остальные
 * связи — текст адреса, и база их не защищает вовсе: обложка книги — это
 * `BookVersion.coverImageUrl`, обычная строка (`schema.prisma:60`).
 *
 * Отсюда два дефекта одного корня, и оба закрываются этим файлом:
 *
 * - **LEGACY-060:** `DELETE /media/:id` сносил обложку опубликованной книги, отвечая
 *   `{ success: true }`;
 * - **LEGACY-058:** `cleanup-orphans` считал сиротой любую обложку — замер на проде
 *   05.08.2026 дал 56 кандидатов из 56 записей, включая все восемь живых обложек.
 *
 * 🔴 **Правило здесь одно на оба пути намеренно.** Раздельные проверки разошлись бы:
 * поле, добавленное в одну, забылось бы в другой, и уборка снова начала бы удалять
 * то, что удалять запрещено вручную. Оба пути читают одни перечни — `MEDIA_FOREIGN_KEYS`
 * ниже и `MEDIA_URL_COLUMNS` (`media-url-columns.ts`); новая связь в схеме добавляется туда
 * одной записью. Сторож `media-references.spec.ts` сверяет со схемой через `Prisma.dmmf`
 * связи `MediaAsset` и строковые поля с окончанием `Url`/`Uri`/`Href`/`Src`/`Key`.
 * ⚠️ Адрес внутри HTML или Json (картинка редактора в тексте главы, `Page.sections`) не видит
 * ни проверка, ни сторож — `LEGACY-421`.
 *
 * Совпадение ищется по вхождению `key`, а не по равенству URL: публичный адрес
 * собирается из базы хранилища, и она может смениться, а `key` — нет.
 */

/** Сколько ссылок показать в ответе: оператору нужен пример, а не полный список. */
const REFERENCE_SAMPLE_LIMIT = 3;

interface ReferenceRow {
  id: string | number;
  title?: string;
}

/** Одна обратная связь `MediaAsset` по внешнему ключу. */
interface MediaForeignKey {
  relation: keyof Prisma.MediaAssetWhereInput;
  describe: (row: ReferenceRow) => string;
  matching: (prisma: PrismaService, assetId: string, take: number) => Promise<ReferenceRow[]>;
}

/**
 * 🔴 Все внешние ключи на `MediaAsset` (LEGACY-413). Правовые три — документ лицензии,
 * актив претензии и её вложение — критерий сироты раньше не видел, и уборка удалила бы
 * файл, на который ссылается правовая запись.
 */
const MEDIA_FOREIGN_KEYS: readonly MediaForeignKey[] = [
  {
    relation: 'audioChapters',
    describe: (row) => `audio chapter "${row.title}" (${row.id})`,
    matching: (prisma, assetId, take) =>
      prisma.audioChapter.findMany({
        where: { mediaId: assetId },
        select: { id: true, title: true },
        take,
      }),
  },
  {
    relation: 'previewVersions',
    describe: (row) => `book version preview "${row.title}" (${row.id})`,
    matching: (prisma, assetId, take) =>
      prisma.bookVersion.findMany({
        where: { previewMediaId: assetId },
        select: { id: true, title: true },
        take,
      }),
  },
  {
    relation: 'rightsLicenseDocuments',
    describe: (row) => `rights license document (${row.id})`,
    matching: (prisma, assetId, take) =>
      prisma.rightsLicense.findMany({
        where: { documentMediaAssetId: assetId },
        select: { id: true },
        take,
      }),
  },
  {
    relation: 'rightsClaimMediaAssets',
    describe: (row) => `rights claim (${row.id})`,
    matching: (prisma, assetId, take) =>
      prisma.rightsClaim.findMany({
        where: { mediaAssetId: assetId },
        select: { id: true },
        take,
      }),
  },
  {
    relation: 'rightsClaimAttachments',
    describe: (row) => `rights claim attachment "${row.title}" (${row.id})`,
    matching: (prisma, assetId, take) =>
      prisma.rightsClaimAttachment.findMany({
        where: { mediaAssetId: assetId },
        select: { id: true, title: true },
        take,
      }),
  },
];

/** Обратные связи, которые проверяются. Сверяется со схемой в спеке. */
export const MEDIA_FOREIGN_KEY_RELATIONS: readonly string[] = MEDIA_FOREIGN_KEYS.map(
  (fk) => fk.relation,
);

/** Условие «ни одна строка не ссылается на ассет внешним ключом» — для stage 1 уборки. */
export const MEDIA_UNREFERENCED_BY_FK: Prisma.MediaAssetWhereInput = Object.fromEntries(
  MEDIA_FOREIGN_KEYS.map((fk) => [fk.relation, { none: {} }]),
);

/** Какие колонки проверяются, в виде `Model.field`. Сверяется со схемой в спеке. */
export const MEDIA_URL_REFERENCE_FIELDS: readonly string[] = MEDIA_URL_COLUMNS.map(
  (column) => column.field,
);

/**
 * Сколько ключей уходит в один запрос уборки. `OR` из `contains` — это `LIKE` на каждый ключ,
 * и пачка держит и размер SQL, и объём ответа в пределах, не зависящих от числа кандидатов.
 */
const KEYS_PER_QUERY = 100;

/** Сколько запросов отказа 409 идёт одновременно: четыре из десяти соединений пула. */
const DESCRIPTOR_CONCURRENCY = 4;

/**
 * Человекочитаемый перечень ссылок на конкретный ассет — для отказа 409.
 *
 * `AudioChapter` проверяется дважды: по внешнему ключу и по строке. Ключ есть, но
 * мягкому удалению он не мешает, а часть записей могла быть создана до его появления.
 */
export async function findMediaReferenceDescriptors(
  prisma: PrismaService,
  asset: { id: string; key: string },
): Promise<string[]> {
  const lookups: Array<() => Promise<string[]>> = [
    ...MEDIA_FOREIGN_KEYS.map(
      (fk) => async () =>
        (await fk.matching(prisma, asset.id, REFERENCE_SAMPLE_LIMIT)).map(fk.describe),
    ),
    ...(asset.key.trim()
      ? MEDIA_URL_COLUMNS.map(
          (column) => async () =>
            (await column.find(prisma, [asset.key], REFERENCE_SAMPLE_LIMIT)).map(column.describe),
        )
      : []),
  ];

  // Три десятка запросов: разом заняли бы весь пул, по одному — долго держали бы запрос.
  const found: string[][] = [];
  for (let start = 0; start < lookups.length; start += DESCRIPTOR_CONCURRENCY) {
    const batch = lookups.slice(start, start + DESCRIPTOR_CONCURRENCY);
    found.push(...(await Promise.all(batch.map((lookup) => lookup()))));
  }

  const references: string[] = [];
  for (const descriptor of found.flat()) {
    if (!references.includes(descriptor)) references.push(descriptor);
  }
  return references;
}

/**
 * Какие из ключей упомянуты строкой хотя бы в одной колонке `MEDIA_URL_COLUMNS` — для уборки.
 *
 * Совпадение ищет база: по запросу на колонку на пачку из `KEYS_PER_QUERY` ключей, и в память
 * приходят только совпавшие строки, а не колонка целиком. Запросы идут по очереди: уборка
 * уже держит одно соединение под замком.
 */
export async function findUrlReferencedKeys(
  prisma: PrismaService,
  keys: readonly string[],
): Promise<Set<string>> {
  const referenced = new Set<string>();
  // Пустой ключ в `contains` совпал бы с любой строкой и молча остановил бы уборку.
  // Ошибка любого запроса не глотается: прогон обрывается, а не считает ассет сиротой.
  const candidates = keys.filter((key) => key.trim().length > 0);
  for (let start = 0; start < candidates.length; start += KEYS_PER_QUERY) {
    const batch = candidates.slice(start, start + KEYS_PER_QUERY);
    for (const column of MEDIA_URL_COLUMNS) {
      for (const row of await column.find(prisma, batch)) {
        if (!row.url) continue;
        for (const key of batch) if (row.url.includes(key)) referenced.add(key);
      }
    }
  }
  return referenced;
}
