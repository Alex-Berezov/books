import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, WorldEntityType } from '@prisma/client';
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
  WORLD_IMAGE_ENTITY_CHANGED,
  WORLD_IMAGE_KEY_CONFLICT,
  WORLD_IMAGE_NONE,
  WORLD_IMAGE_REFUSAL_CODES,
  WORLD_IMAGE_NOT_ALLOWED,
  worldImageLimitsOf,
} from './world-image.constants';

/**
 * Строка картинки для вкладки и правила занятости ключа (решения `F08 | F08-12c-2` круг 1 Q1, Q2): тип
 * и файлы. Один отбор на `state` и `lockImageRow` - правило занятости судит по одним полям.
 */
const IMAGE_SELECT = {
  entityType: true,
  imageReadAt: true,
  image: { select: WORLD_IMAGE_FILE_SELECT },
  pending: { select: WORLD_IMAGE_FILE_SELECT },
} as const satisfies Prisma.BookWorldImageSelect;

type ImageRow = Prisma.BookWorldImageGetPayload<{ select: typeof IMAGE_SELECT }>;

/** Сущность версии, её тип и право на картинку (Р5, `F08-12c-2`): только по типу и роли. */
interface WorldImageSubject {
  bookId: string;
  type: WorldEntityType;
  allowed: boolean;
}

/**
 * Предел чтения сущностей ключа во всех версиях книги: сущность одна на версию и ключ, версий у книги -
 * по языку и формату, их единицы. Предел - страховка от безлимитной выборки, а не отсечение: правило
 * занятости смотрит всех.
 */
const KEY_ENTITIES_MAX = 500;

/** Сущность ключа в одной из версий книги: её версия, тип и роль - для права на картинку. */
interface KeyEntity {
  bookVersionId: string;
  type: string;
  role: string | null;
}

/** Строка картинки под замком и живость её ожидающего файла. */
export interface LockedImageRow {
  id: string;
  pendingMediaId: string | null;
  pendingDeleted: boolean | null;
}

const notAllowed = () =>
  codedConflict(
    WORLD_IMAGE_NOT_ALLOWED,
    'Only a main or secondary character or a place gets an illustration',
  );

const entityChanged = () =>
  codedConflict(WORLD_IMAGE_ENTITY_CHANGED, 'The entity type changed meanwhile: reload it');

const keyConflict = () =>
  codedConflict(
    WORLD_IMAGE_KEY_CONFLICT,
    'The image of this key belongs to an entity of another type that still has the right to it',
  );

/**
 * Иллюстрация героя и места (`F08-11a`, `F08-12c-2`; решения арбитра `F08 | F08-11` Р2-Р5, `F08 | F08-11a` Q1). Строка
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
   * и размерам (`checkImageBytes`, предел по типу - `worldImageLimitsOf`), файл ложится в хранилище под серверным
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
    const checked = checkImageBytes(bytes, worldImageLimitsOf(subject.type));
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
        const row = await lockImageRow(tx, bookVersionId, subject, key);
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
    // Строка другого типа (тот же ключ - сущность другого типа, `F08 | F08-12c-2`) - пустая; занята ли
    // она - тем же правилом, что под замком загрузки и «Accept» (Q2).
    if (!row || row.entityType === subject.type) return toState(key, subject, row, false);
    const entities = await this.prisma.bookWorldEntity.findMany({
      where: { key, bookVersion: { bookId: subject.bookId } },
      select: { bookVersionId: true, type: true, role: true },
      take: KEY_ENTITIES_MAX,
    });
    return toState(key, subject, null, rowOccupied(row, entities));
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
      const row = await lockImageRow(tx, bookVersionId, subject, key);
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

  /** Сущность версии: книга, тип и право на картинку (Р5). Нет сущности - 404. */
  private async subject(bookVersionId: string, key: string): Promise<WorldImageSubject> {
    const entity = await this.prisma.bookWorldEntity.findUnique({
      where: { bookVersionId_key: { bookVersionId, key } },
      select: { type: true, role: true, bookVersion: { select: { bookId: true } } },
    });
    if (!entity) throw new NotFoundException('World entity not found');
    return imageSubject(entity);
  }
}

/**
 * Право на картинку (Р5, Q1): `worldImageAllowed` - герой `main`/`secondary` или место. Внешность из текста
 * условием не служит (решение арбитра `F08 | F08-11d` Q10).
 */
function imageSubject(entity: {
  type: WorldEntityType;
  role: string | null;
  bookVersion: { bookId: string };
}): WorldImageSubject {
  return {
    bookId: entity.bookVersion.bookId,
    type: entity.type,
    allowed: worldImageAllowed(entity),
  };
}

function toState(
  key: string,
  subject: WorldImageSubject,
  row: ImageRow | null,
  keyConflict: boolean,
): WorldImageStateDto {
  // Принятая - тем же правилом, что видит сайт (`acceptedImageOf`), второй копии нет.
  const accepted = row ? acceptedImageOf(row) : null;
  return {
    key,
    allowed: subject.allowed,
    roleAllowed: subject.allowed,
    accepted: fileDto(accepted),
    acceptedAt: accepted && row ? row.imageReadAt : null,
    pending: fileDto(row ? pendingImageOf(row) : null),
    keyConflict,
  };
}

/**
 * Занята ли строка чужого типа (решение арбитра `F08 | F08-12c-2` круг 1 Q1): да, только если у неё живой
 * принятый (`acceptedImageOf`) или живой ожидающий (`pendingImageOf`) файл **и** среди сущностей ключа
 * во всех версиях книги есть сущность типа строки с правом на картинку (`worldImageAllowed`). Оставшийся
 * от снятой генерации `operationId` в занятость не входит. Одна функция на вкладку (`state`) и замок
 * (`lockImageRow`); сущности ей передают, под замком - взятые `FOR SHARE`.
 */
function rowOccupied(row: ImageRow, entities: readonly KeyEntity[]): boolean {
  if (acceptedImageOf(row) === null && pendingImageOf(row) === null) return false;
  return entities.some((e) => e.type === row.entityType && worldImageAllowed(e));
}

/**
 * Живая ожидающая картинка строки (вкладка World и занятость ключа, `F08-12c-2`): файл не удалён. Только
 * для админки: сайт ожидающую ячейку не читает (`acceptedImageOf` в `world-image-public.ts`).
 */
function pendingImageOf(row: { pending: WorldImageFile | null }): WorldImageFile | null {
  return row.pending && !row.pending.isDeleted ? row.pending : null;
}

function fileDto(file: WorldImageFile | null): WorldImageFileDto | null {
  return file ? { mediaId: file.id, url: file.url, width: file.width, height: file.height } : null;
}

/**
 * Строка картинки под замком: заводится с типом сущности, если её нет (`ON CONFLICT DO NOTHING` - два
 * первых обращения не дают P2002, который оборвал бы транзакцию), и берётся `FOR UPDATE`. Затем
 * сущности ключа во всех версиях книги берутся `FOR SHARE` (круг 2): импорт мира, меняющий их тип или
 * роль уже заведённых сущностей, ждёт конца транзакции (вставку новой сущности `FOR SHARE` не ловит - принятый риск,
 * решение `F08 | F08-12c-2` круг 3, хвост в журнале). Своя сущность сверяется
 * с прочитанной до транзакции: тип сменился - 409 `WORLD_IMAGE_ENTITY_CHANGED`, право потеряно -
 * 409 `WORLD_IMAGE_NOT_ALLOWED`. Строка чужого типа, занятая по `rowOccupied`, - 409
 * `WORLD_IMAGE_KEY_CONFLICT`; свободная переводится на тип сущности с очисткой ячеек (решение
 * `F08 | F08-12c-2` круг 1 Q1; файлы забирает уборка сирот). Всё читается **отдельными операторами
 * после замка** (L-019): при `read committed` оператор, ждавший замка, видит соседние таблицы снимком
 * до ожидания.
 */
async function lockImageRow(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
  subject: WorldImageSubject,
  key: string,
): Promise<LockedImageRow> {
  const { bookId, type } = subject;
  const now = new Date();
  await tx.$executeRaw`
    INSERT INTO "BookWorldImage" ("id", "bookId", "key", "entityType", "createdAt", "updatedAt")
    VALUES (${randomUUID()}, ${bookId}, ${key}, ${type}::"WorldEntityType", ${utcTimestamp(now)}, ${utcTimestamp(now)})
    ON CONFLICT ("bookId", "key") DO NOTHING`;
  const [locked] = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT "id" FROM "BookWorldImage"
    WHERE "bookId" = ${bookId} AND "key" = ${key}
    FOR UPDATE`;
  const entities = await tx.$queryRaw<KeyEntity[]>`
    SELECT e."bookVersionId", e."type"::text AS "type", e."role"
    FROM "BookWorldEntity" e
    JOIN "BookVersion" v ON v."id" = e."bookVersionId"
    WHERE v."bookId" = ${bookId} AND e."key" = ${key}
    LIMIT ${KEY_ENTITIES_MAX}
    FOR SHARE OF e`;
  const own = entities.find((e) => e.bookVersionId === bookVersionId);
  if (!own) throw new NotFoundException('World entity not found');
  if (own.type !== type) throw entityChanged();
  if (!worldImageAllowed(own)) throw notAllowed();
  const row = await tx.bookWorldImage.findUniqueOrThrow({
    where: { id: locked.id },
    select: IMAGE_SELECT,
  });
  if (row.entityType !== type) {
    if (rowOccupied(row, entities)) throw keyConflict();
    await tx.bookWorldImage.update({
      where: { id: locked.id },
      data: {
        entityType: type,
        imageMediaId: null,
        imageReadAt: null,
        pendingMediaId: null,
        operationId: null,
      },
    });
  }
  const rows = await tx.$queryRaw<LockedImageRow[]>`
    SELECT i."id", i."pendingMediaId", m."isDeleted" AS "pendingDeleted"
    FROM "BookWorldImage" i
    LEFT JOIN "MediaAsset" m ON m."id" = i."pendingMediaId"
    WHERE i."id" = ${locked.id}`;
  return rows[0];
}
