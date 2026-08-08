import { PrismaService } from '../../prisma/prisma.service';

/**
 * Кто ссылается на медиа-объект **строкой URL**, а не внешним ключом.
 *
 * Внешние ключи на `MediaAsset` есть только у `AudioChapter.mediaId` и
 * `BookVersion.previewMediaId`. Всё остальное связано текстом адреса, и база такие
 * связи не защищает: обложка книги — это `BookVersion.coverImageUrl`, обычная
 * строка (`schema.prisma:60`).
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
 * то, что удалять запрещено вручную. Добавляя новое поле-адрес в схему, добавляйте
 * его в **обе** функции ниже — они лежат рядом именно поэтому.
 *
 * Совпадение ищется по вхождению `key`, а не по равенству URL: публичный адрес
 * собирается из базы хранилища, и она может смениться, а `key` — нет.
 */

/** Сколько ссылок показать в ответе: оператору нужен пример, а не полный список. */
const REFERENCE_SAMPLE_LIMIT = 3;

/** Документирует, что именно проверяется. Используется в тестах и сообщениях. */
export const MEDIA_URL_REFERENCE_FIELDS = [
  'BookVersion.coverImageUrl',
  'AudioChapter.audioUrl',
  'User.avatarUrl',
  'AuthorTranslation.photoUrl',
] as const;

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
  const [covers, audioByMedia, audioByUrl, avatars, photos] = await Promise.all([
    prisma.bookVersion.findMany({
      where: { coverImageUrl: { contains: asset.key } },
      select: { id: true, title: true },
      take: REFERENCE_SAMPLE_LIMIT,
    }),
    prisma.audioChapter.findMany({
      where: { mediaId: asset.id },
      select: { id: true, title: true },
      take: REFERENCE_SAMPLE_LIMIT,
    }),
    prisma.audioChapter.findMany({
      where: { audioUrl: { contains: asset.key } },
      select: { id: true, title: true },
      take: REFERENCE_SAMPLE_LIMIT,
    }),
    prisma.user.findMany({
      where: { avatarUrl: { contains: asset.key } },
      select: { id: true },
      take: REFERENCE_SAMPLE_LIMIT,
    }),
    prisma.authorTranslation.findMany({
      where: { photoUrl: { contains: asset.key } },
      select: { id: true },
      take: REFERENCE_SAMPLE_LIMIT,
    }),
  ]);

  const references: string[] = [];
  for (const version of covers) references.push(`book version "${version.title}" (${version.id})`);
  for (const chapter of [...audioByMedia, ...audioByUrl]) {
    const descriptor = `audio chapter "${chapter.title}" (${chapter.id})`;
    if (!references.includes(descriptor)) references.push(descriptor);
  }
  for (const user of avatars) references.push(`user avatar (${user.id})`);
  for (const translation of photos) references.push(`author photo (${translation.id})`);

  return references;
}

/**
 * Проверка «на этот ключ ссылаются» для **пачки** ассетов.
 *
 * Уборка идёт по всем записям сразу, и запрос на каждого кандидата дал бы N обращений
 * к базе. Здесь адреса вычитываются один раз — четыре запроса независимо от числа
 * кандидатов, — и дальше сравнение идёт в памяти.
 */
export async function loadUrlReferenceChecker(
  prisma: PrismaService,
): Promise<(key: string) => boolean> {
  const [covers, audio, avatars, photos] = await Promise.all([
    prisma.bookVersion.findMany({ select: { coverImageUrl: true } }),
    prisma.audioChapter.findMany({ select: { audioUrl: true } }),
    prisma.user.findMany({ where: { avatarUrl: { not: null } }, select: { avatarUrl: true } }),
    prisma.authorTranslation.findMany({
      where: { photoUrl: { not: null } },
      select: { photoUrl: true },
    }),
  ]);

  const urls: string[] = [
    ...covers.map((row) => row.coverImageUrl),
    ...audio.map((row) => row.audioUrl),
    ...avatars.map((row) => row.avatarUrl ?? ''),
    ...photos.map((row) => row.photoUrl ?? ''),
  ].filter(Boolean);

  return (key: string) => {
    if (!key) return false;
    return urls.some((url) => url.includes(key));
  };
}
