import { ConflictException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { StorageService } from '../../shared/storage/storage.interface';
import { findMediaReferenceDescriptors } from './media-references';

/**
 * Удаление медиа-объекта - один протокол на оба входа: `DELETE /media/:id` и `DELETE /uploads`
 * (`LEGACY-444`). Раздельные копии разошлись бы так же, как разошлись бы проверки ссылок
 * (`media-references.ts`): правка протокола уборки (`LEGACY-421`) прошла бы мимо второй.
 *
 * Порядок: проверка ссылок (занято - 409, восстановить файл нечем) → пометка записи
 * `isDeleted` + `deletedAt` для stage 2 уборки → удаление файла. Отказ хранилища
 * не проглатывается молча: запись остаётся помеченной, уборка через `hardDays` повторит
 * попытку, свидетельство - error-лог. Объект без записи (`asset: null`) только удаляется.
 */
export async function deleteMediaObject(
  deps: { prisma: PrismaService; storage: StorageService; logger: Logger },
  target: { key: string; asset: { id: string; isDeleted: boolean; deletedAt: Date | null } | null },
): Promise<{ storageDeleted: boolean }> {
  const { prisma, storage, logger } = deps;
  const { key, asset } = target;

  const references = await findMediaReferenceDescriptors(prisma, { id: asset?.id ?? '', key });
  if (references.length > 0) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: 'Media is still referenced and was not deleted',
      references,
    });
  }

  if (asset) {
    // `deletedAt` обязателен: без него stage 2 уборки строку не выбирает никогда (LEGACY-421).
    await prisma.mediaAsset.update({
      where: { id: asset.id },
      // Повторный DELETE срок не отодвигает: у ассета, помеченного сейчас, дата первой пометки
      // остаётся. Проверка `isDeleted` страхует от даты, оставшейся у ожившей строки.
      data: {
        isDeleted: true,
        deletedAt: asset.isDeleted && asset.deletedAt ? asset.deletedAt : new Date(),
      },
    });
  }

  try {
    await storage.delete(key);
    return { storageDeleted: true };
  } catch (error) {
    logger.error(
      `Storage object was not deleted (media ${asset?.id ?? 'without record'}, key: ${key}). ` +
        'The database record, if any, is marked deleted; the media cleanup, if enabled, tries once ' +
        'more after MEDIA_CLEANUP_HARD_DAYS, otherwise the object has to be removed by hand.',
      error instanceof Error ? error.stack : String(error),
    );
    return { storageDeleted: false };
  }
}
