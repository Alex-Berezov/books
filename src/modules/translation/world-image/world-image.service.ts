import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../../prisma/prisma.service';
import { checkImageBytes } from '../../../shared/image/image-check';
import { utcTimestamp } from '../../../shared/prisma/utc-timestamp';
import { STORAGE_SERVICE, StorageService } from '../../../shared/storage/storage.interface';
import { ILLUSTRATIONS_KEY_PREFIX, uploadObjectKey } from '../../uploads/uploads.service';
import {
  acceptedImageOf,
  WORLD_IMAGE_FILE_SELECT,
  WorldImageFile,
  worldImageAllowed,
} from '../../book-world/world-image-public';
import { codedConflict } from '../../../shared/errors/coded-conflict';
import { codedBadRequest } from '../../../shared/errors/coded-error';
import { DRAFT_TX_OPTIONS } from '../content-draft/content-draft.constants';
import { WorldImageFileDto, WorldImageStateDto } from '../dto/world-image-response.dto';
import {
  WORLD_IMAGE_CHANGED,
  WORLD_IMAGE_LIMITS,
  WORLD_IMAGE_NONE,
  WORLD_IMAGE_REFUSAL_CODES,
  WORLD_IMAGE_NOT_ALLOWED,
} from './world-image.constants';

const IMAGE_SELECT = {
  imageReadAt: true,
  image: { select: WORLD_IMAGE_FILE_SELECT },
  pending: { select: WORLD_IMAGE_FILE_SELECT },
} as const satisfies Prisma.BookWorldImageSelect;

type ImageRow = Prisma.BookWorldImageGetPayload<{ select: typeof IMAGE_SELECT }>;

/** Герой версии и его право на картинку (Р5): только по типу и роли. */
interface WorldPortraitSubject {
  bookId: string;
  allowed: boolean;
}

/** Строка картинки под замком и живость её ожидающего файла. */
export interface LockedImageRow {
  id: string;
  pendingMediaId: string | null;
  pendingDeleted: boolean | null;
}

const notAllowed = () =>
  codedConflict(WORLD_IMAGE_NOT_ALLOWED, 'Only a main or secondary character gets an illustration');

/**
 * Иллюстрация героя (`F08-11a`; решения арбитра `F08 | F08-11` Р2-Р5, `F08 | F08-11a` Q1). Строка
 * `BookWorldImage` - на книгу и ключ; «Accept» переносит ожидающую ячейку в принятую. Генерации
 * моделью нет (`F08-11d-1`, решение владельца): сервис модель не зовёт. Запись строки - под замком
 * строки (`FOR UPDATE`).
 */
@Injectable()
export class WorldImageService {
  private readonly logger = new Logger(WorldImageService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(STORAGE_SERVICE) private readonly storage: StorageService,
  ) {}

  /**
   * Загрузка файла (`F08-11d-3`, решение арбитра `F08 | F08-11d` Q6): байты проверяются по сигнатуре
   * и размерам (`checkImageBytes`, `WORLD_IMAGE_LIMITS`), файл ложится в хранилище под серверным
   * ключом, `MediaAsset` и ожидающая ячейка - одной транзакцией под замком строки. Принятая не
   * трогается; прежняя ожидающая остаётся без ссылки - её убирает уборка сирот.
   */
  async upload(
    bookVersionId: string,
    key: string,
    bytes: Buffer | undefined,
    userId: string,
  ): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    if (!subject.allowed) throw notAllowed();
    if (!bytes || bytes.length === 0) throw new BadRequestException('File is required');
    const checked = checkImageBytes(bytes, WORLD_IMAGE_LIMITS);
    if (!checked.ok) {
      const code = WORLD_IMAGE_REFUSAL_CODES[checked.reason];
      throw codedBadRequest(code, `The image was refused: ${code}`);
    }
    // Файл ложится до транзакции; не лёг файл целиком или не легла запись - файл удаляется сразу
    // (без `MediaAsset` уборка его не увидит).
    const objectKey = uploadObjectKey(ILLUSTRATIONS_KEY_PREFIX, checked.info.ext);
    let linked = false;
    try {
      await this.storage.save(objectKey, checked.bytes, { contentType: checked.info.mime });
      await this.prisma.$transaction(async (tx) => {
        const row = await lockImageRow(tx, subject.bookId, key);
        const asset = await tx.mediaAsset.create({
          data: {
            key: objectKey,
            url: this.storage.getPublicUrl(objectKey),
            contentType: checked.info.mime,
            size: checked.bytes.length,
            width: checked.info.width,
            height: checked.info.height,
            createdById: userId,
          },
          select: { id: true },
        });
        await tx.bookWorldImage.update({
          where: { id: row.id },
          data: { pendingMediaId: asset.id },
        });
      }, DRAFT_TX_OPTIONS);
      linked = true;
    } finally {
      if (!linked) await this.dropFile(objectKey);
    }
    return this.state(bookVersionId, key);
  }

  /** Файл, который не лёг в строку: удалить; сбой - в лог. */
  private async dropFile(objectKey: string): Promise<void> {
    try {
      await this.storage.delete(objectKey);
    } catch (error) {
      this.logger.warn(
        `World image file was not removed: key=${objectKey} error=${error instanceof Error ? error.name : typeof error}`,
      );
    }
  }

  async state(bookVersionId: string, key: string): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    const row = await this.prisma.bookWorldImage.findUnique({
      where: { bookId_key: { bookId: subject.bookId, key } },
      select: IMAGE_SELECT,
    });
    return toState(key, subject, row);
  }

  /**
   * «Accept» (Р3): ожидающая - в принятую. Без живой ожидающей - 409 `WORLD_IMAGE_NONE`, чужая
   * ожидающая - 409 `WORLD_IMAGE_CHANGED`, сущность без права на картинку - 409 (Q1).
   */
  async accept(
    bookVersionId: string,
    key: string,
    pendingMediaId: string,
  ): Promise<WorldImageStateDto> {
    const subject = await this.subject(bookVersionId, key);
    if (!subject.allowed) throw notAllowed();
    await this.prisma.$transaction(async (tx) => {
      const row = await lockImageRow(tx, subject.bookId, key);
      if (!row.pendingMediaId || row.pendingDeleted) {
        throw codedConflict(WORLD_IMAGE_NONE, 'There is no pending illustration to accept');
      }
      if (row.pendingMediaId !== pendingMediaId) {
        throw codedConflict(WORLD_IMAGE_CHANGED, 'The illustration was replaced: reload it');
      }
      await tx.bookWorldImage.update({
        where: { id: row.id },
        data: { imageMediaId: row.pendingMediaId, imageReadAt: new Date(), pendingMediaId: null },
      });
    }, DRAFT_TX_OPTIONS);
    return this.state(bookVersionId, key);
  }

  /** Герой версии: книга и право на картинку (Р5). Нет сущности - 404. */
  private async subject(bookVersionId: string, key: string): Promise<WorldPortraitSubject> {
    const entity = await this.prisma.bookWorldEntity.findUnique({
      where: { bookVersionId_key: { bookVersionId, key } },
      select: { type: true, role: true, bookVersion: { select: { bookId: true } } },
    });
    if (!entity) throw new NotFoundException('World entity not found');
    return portraitSubject(entity);
  }
}

/**
 * Право на портрет (Р5, Q1): `worldImageAllowed` - герой `main`/`secondary`. Внешность из текста
 * условием не служит (решение арбитра `F08 | F08-11d` Q10).
 */
function portraitSubject(entity: {
  type: string;
  role: string | null;
  bookVersion: { bookId: string };
}): WorldPortraitSubject {
  return { bookId: entity.bookVersion.bookId, allowed: worldImageAllowed(entity) };
}

function toState(
  key: string,
  subject: WorldPortraitSubject,
  row: ImageRow | null,
): WorldImageStateDto {
  // Принятая - тем же правилом, что видит сайт (`acceptedImageOf`), второй копии нет.
  const accepted = row ? acceptedImageOf(row) : null;
  return {
    key,
    allowed: subject.allowed,
    roleAllowed: subject.allowed,
    accepted: fileDto(accepted),
    acceptedAt: accepted && row ? row.imageReadAt : null,
    pending: fileDto(row?.pending && !row.pending.isDeleted ? row.pending : null),
  };
}

function fileDto(file: WorldImageFile | null): WorldImageFileDto | null {
  return file ? { mediaId: file.id, url: file.url, width: file.width, height: file.height } : null;
}

/**
 * Строка картинки под замком: заводится, если её нет (`ON CONFLICT DO NOTHING` - два первых
 * обращения не дают P2002, который оборвал бы транзакцию), и берётся `FOR UPDATE`. Живость
 * ожидающего файла читается **отдельным оператором после замка** (L-019): при `read committed`
 * оператор, ждавший замка, видит соседние таблицы снимком до ожидания.
 */
async function lockImageRow(
  tx: Prisma.TransactionClient,
  bookId: string,
  key: string,
): Promise<LockedImageRow> {
  const now = new Date();
  await tx.$executeRaw`
    INSERT INTO "BookWorldImage" ("id", "bookId", "key", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${bookId}, ${key}, ${utcTimestamp(now)}, ${utcTimestamp(now)})
    ON CONFLICT ("bookId", "key") DO NOTHING`;
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BookWorldImage"
    WHERE "bookId" = ${bookId} AND "key" = ${key}
    FOR UPDATE`;
  const rows = await tx.$queryRaw<LockedImageRow[]>`
    SELECT i."id", i."pendingMediaId", m."isDeleted" AS "pendingDeleted"
    FROM "BookWorldImage" i
    LEFT JOIN "MediaAsset" m ON m."id" = i."pendingMediaId"
    WHERE i."id" = ${locked.id}`;
  return rows[0];
}
