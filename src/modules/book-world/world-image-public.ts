import { Prisma, WorldEntityType } from '@prisma/client';
import type { BookAnalysisRole } from '../book-analysis/dto/book-analysis-blocks.dto';
import { BookWorldImageDto } from './dto/book-world-response.dto';

/**
 * Роли героя с иллюстрацией (решение арбитра `F08 | F08-11` Р5): у пары и эпизодических героев
 * её нет; у места есть с `F08-12c-2` (любого вида, решение `F08 | F08-12c-2`).
 * Одно правило на вкладку World, «Accept» и публичную выдачу (`F08 | F08-11a` Q1).
 */
export const WORLD_IMAGE_ROLES = [
  'main',
  'secondary',
] as const satisfies readonly BookAnalysisRole[];

/**
 * Сущность этой версии вправе иметь иллюстрацию: герой `main`/`secondary` (Р5, Q1) или место
 * (`F08-12c-2`).
 */
export function worldImageAllowed(entity: { type: string; role: string | null }): boolean {
  if (entity.type === 'place') return true;
  return (
    entity.type === 'character' &&
    (WORLD_IMAGE_ROLES as readonly string[]).includes(entity.role ?? '')
  );
}

/** Отбор файла картинки - один на сайт и вкладку World (`acceptedImageOf` читает его поля). */
export const WORLD_IMAGE_FILE_SELECT = {
  id: true,
  url: true,
  width: true,
  height: true,
  isDeleted: true,
} as const satisfies Prisma.MediaAssetSelect;

/** Файл картинки, как его видит сайт: удалённый `MediaAsset` (`isDeleted`) - не картинка. */
export interface WorldImageFile {
  id: string;
  url: string;
  width: number | null;
  height: number | null;
  isDeleted: boolean;
}

/**
 * Принятая картинка строки - единственное правило «на сайте» (Р3): принятая ячейка при
 * `imageReadAt` и живой файл. Ожидающую ячейку не читает вовсе. Его же зовёт вкладка World.
 */
export function acceptedImageOf(row: {
  imageReadAt: Date | null;
  image: WorldImageFile | null;
}): WorldImageFile | null {
  return row.imageReadAt && row.image && !row.image.isDeleted ? row.image : null;
}

/**
 * Принятая иллюстрация сущности (`F08-11a`, решения арбитра `F08 | F08-11` Р2, Р3): строка на книгу
 * и ключ. Публичность самой страницы проверяет её ручка (U7); здесь - только право сущности этой
 * версии на картинку (`F08 | F08-11a` Q1): героя понизили - картинка не показывается, строка
 * остаётся и вернётся вместе с правом.
 */
export async function acceptedWorldImage(
  client: Prisma.TransactionClient,
  bookVersionId: string,
  key: string,
  entity: { type: string; role: string | null },
): Promise<BookWorldImageDto | null> {
  if (!worldImageAllowed(entity)) return null;
  // Тип строки - тип сущности этой версии (`F08 | F08-12c-2`): портрет героя одной версии не виден
  // месту на том же ключе другой версии и наоборот; чужая по типу строка не трогается.
  const row = await client.bookWorldImage.findFirst({
    where: {
      key,
      entityType: entity.type as WorldEntityType,
      book: { versions: { some: { id: bookVersionId } } },
    },
    select: {
      imageReadAt: true,
      image: { select: WORLD_IMAGE_FILE_SELECT },
    },
  });
  const image = row ? acceptedImageOf(row) : null;
  return image ? { url: image.url, width: image.width, height: image.height } : null;
}
