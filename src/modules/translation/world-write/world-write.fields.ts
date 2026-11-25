import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { ContentDraft, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BOOK_WORLD_PUBLIC_SELECT,
  readStoredEntity,
  type StoredWorldEntity,
} from '../../book-world/book-world-data';
import { BookWorldService } from '../../book-world/book-world.service';
import { BOOK_WORLD_LIMITS } from '../../book-world/dto/book-world-blocks.dto';
import type { UpdateBookWorldEntityDto } from '../../book-world/dto/update-book-world.dto';
import { httpCode, llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { sourceKey } from '../analysis-write/analysis-write.data';
import { DRAFT_TX_OPTIONS } from '../content-draft/content-draft.constants';
import { RunGone } from '../draft-quality/run-steps';
import {
  WORLD_BLOCK_CHANGED,
  WORLD_ITEM_NOT_PROPOSED,
  WORLD_REGEN_IN_PROGRESS,
  WORLD_PROPOSAL_CHANGED,
  WORLD_WRITE_NOT_READY,
  WORLD_WRITE_REFUSED,
} from './world-write.constants';
import {
  blockIsEmpty,
  entityBlock,
  entityKindOf,
  proposalPrint,
  readWorldData,
  valuePrint,
  withItem,
  WorldEntityKind,
  WorldItem,
  WorldSource,
  WorldWriteData,
  worldDataJson,
} from './world-write.data';

/**
 * Кто вправе менять данные хода: задача хода (строящийся ход своей операции), задача перегенерации
 * (ход `ready` и отметка её операции на пункте) или ручка редактора (ход `ready`).
 */
export type WorldGate =
  | { kind: 'run'; operationId: string }
  | { kind: 'regen'; operationId: string; index: number }
  | { kind: 'ready' };

export const worldRunGate = (operationId: string): WorldGate => ({ kind: 'run', operationId });
export const worldRegenGate = (operationId: string, index: number): WorldGate => ({
  kind: 'regen',
  operationId,
  index,
});
export const worldReadyGate: WorldGate = { kind: 'ready' };

function passes(row: ContentDraft, data: WorldWriteData, gate: WorldGate): boolean {
  if (gate.kind === 'run') return row.status === 'building' && row.operationId === gate.operationId;
  if (row.status !== 'ready') return false;
  return gate.kind === 'ready' || data.items[gate.index]?.regen?.operationId === gate.operationId;
}

/** Сущность для решения о записи: блоки, отметка публикации и время правки (сверка записи). */
const ENTITY_SELECT = {
  ...BOOK_WORLD_PUBLIC_SELECT,
  firstPublishedAt: true,
  updatedAt: true,
} as const satisfies Prisma.BookWorldEntitySelect;

interface EntityState {
  entity: StoredWorldEntity;
  published: boolean;
  updatedAt: Date;
}

/** Попыток записи сущности, если её меняют между чтением и записью (`RECORD_CHANGED`). */
const WRITE_ATTEMPTS = 3;

/** Источники блока в списке сущности: объединение по адресу, в пределах импорта. */
export function withWorldSources(
  stored: readonly WorldSource[] | null,
  added: readonly WorldSource[],
): WorldSource[] {
  const out = [...(stored ?? [])];
  const known = new Set(out.map((s) => sourceKey(s.url)));
  for (const source of added) {
    if (known.has(sourceKey(source.url))) continue;
    known.add(sourceKey(source.url));
    out.push(source);
  }
  return out.slice(0, BOOK_WORLD_LIMITS.sources);
}

/**
 * Итог решения: `refused` - только у пункта перегенерации (`only`), импорт отказал: пункт остаётся
 * ждущим, а снятие отметки возвращает его прежнее состояние (`withoutRegen`) с причиной.
 */
export type SettleOutcome = 'settled' | 'gone' | 'refused';

/**
 * Запись хода мира в сущности (`tech.md` §5): решение «записать или предложить» - на текущем
 * состоянии сущности, сама запись - импортом мира `BookWorldService.saveEntity` (те же проверки,
 * `autoTextAt` записи модели, очередь пересчёта присутствия) со сверкой `updatedAt` прочитанной
 * сущности. Данные хода меняются под замком своей строки.
 */
@Injectable()
export class WorldWriteFields {
  constructor(
    private readonly prisma: PrismaService,
    private readonly world: BookWorldService,
  ) {}

  async read(row: Pick<ContentDraft, 'id'>, gate: WorldGate): Promise<WorldWriteData | null> {
    const fresh = await this.prisma.contentDraft.findUnique({ where: { id: row.id } });
    if (!fresh) return null;
    const data = readWorldData(fresh.data);
    return passes(fresh, data, gate) ? data : null;
  }

  /**
   * Правка данных хода под замком строки: `apply` получает данные и транзакцию; `null` - не писать.
   * Ход не прошёл `gate` - `null`.
   */
  async mutate(
    row: Pick<ContentDraft, 'id'>,
    gate: WorldGate,
    apply: (
      data: WorldWriteData,
      tx: Prisma.TransactionClient,
    ) => WorldWriteData | null | Promise<WorldWriteData | null>,
  ): Promise<WorldWriteData | null> {
    return this.prisma.$transaction(async (tx) => {
      const data = await lockedData(tx, row, gate);
      if (!data) return null;
      const next = await apply(data, tx);
      if (next === null) return null;
      await saveData(tx, row, next);
      return next;
    }, DRAFT_TX_OPTIONS);
  }

  async entityState(bookVersionId: string, key: string): Promise<EntityState | null> {
    const row = await this.prisma.bookWorldEntity.findUnique({
      where: { bookVersionId_key: { bookVersionId, key } },
      select: ENTITY_SELECT,
    });
    if (!row) return null;
    return {
      entity: readStoredEntity(row),
      published: row.firstPublishedAt !== null,
      updatedAt: row.updatedAt,
    };
  }

  /**
   * Решение по ждущим пунктам шага `step` (или одному `only`) - по сущности: пункт, чьё значение уже
   * в блоке, - `written` (повтор после обрыва); сущности нет - она создаётся всеми пунктами; блок
   * неопубликованной сущности пуст - пишется; иначе - предложение с отпечатком блока. Запись сущности
   * и итог пунктов - одной транзакцией импорта мира (`within`), с проверкой хода под замком его строки:
   * ход ушёл - запись откатывается, `gone`. Импорт отказал - пункты записи `none` (`WORLD_WRITE_REFUSED`).
   */
  async settleStep(
    row: ContentDraft,
    gate: WorldGate,
    step: number,
    only: number | null = null,
  ): Promise<SettleOutcome> {
    const data = await this.read(row, gate);
    if (!data) return 'gone';
    const waiting = data.items
      .map((item, index) => ({ item, index }))
      .filter(
        ({ item, index }) =>
          item.outcome === 'waiting' && item.step === step && (only === null || index === only),
      );
    let outcome: SettleOutcome = 'settled';
    for (const key of new Set(waiting.map((w) => w.item.key))) {
      const own = waiting.filter((w) => w.item.key === key);
      const settled = await this.settleEntity(
        row,
        gate,
        key,
        entityKindOf(data, key),
        own,
        only !== null,
      );
      if (settled === 'gone') return 'gone';
      if (settled === 'refused') outcome = 'refused';
    }
    return outcome;
  }

  private async settleEntity(
    row: ContentDraft,
    gate: WorldGate,
    key: string,
    kind: WorldEntityKind,
    own: ReadonlyArray<{ item: WorldItem; index: number }>,
    regen: boolean,
  ): Promise<SettleOutcome> {
    for (let attempt = 1; ; attempt++) {
      const state = await this.entityState(row.bookVersionId, key);
      const decided = new Map<number, Partial<WorldItem>>();
      const writes: WorldItem[] = [];
      for (const w of own) {
        const current = state ? entityBlock(state.entity, w.item.block) : null;
        if (state && alreadyIn(state, w.item)) {
          decided.set(w.index, { outcome: 'written', base: null });
        } else if (!state || (!state.published && blockIsEmpty(current))) {
          decided.set(w.index, { outcome: 'written', base: null });
          writes.push(w.item);
        } else {
          decided.set(w.index, { outcome: 'proposed', base: valuePrint(current) });
        }
      }
      const apply = (current: WorldWriteData) => withDecided(current, decided);
      if (writes.length === 0) {
        return (await this.mutate(row, gate, apply)) ? 'settled' : 'gone';
      }
      try {
        await this.write(row.bookVersionId, key, kind, row.language, state, writes, async (tx) => {
          const current = await lockedData(tx, row, gate);
          if (!current) throw new RunGone();
          await saveData(tx, row, apply(current));
        });
        return 'settled';
      } catch (error) {
        if (error instanceof RunGone) return 'gone';
        // Сущность меняют прямо сейчас: после последней попытки - сбой задачи и её повтор, а не
        // «отказ импорта», который навсегда выбросил бы оплаченный текст.
        if (isRecordChanged(error)) {
          if (attempt < WRITE_ATTEMPTS) continue;
          throw error;
        }
        if (!(error instanceof BadRequestException || error instanceof ConflictException)) {
          throw error;
        }
        if (regen) return 'refused';
        for (const w of own) {
          if (writes.includes(w.item)) {
            decided.set(w.index, { outcome: 'none', failedReason: WORLD_WRITE_REFUSED });
          }
        }
        return (await this.mutate(row, gate, apply)) ? 'settled' : 'gone';
      }
    }
  }

  /**
   * Запись пунктов одной сущности импортом мира; тип - по кандидатам хода (`entityKindOf`, `F08-8e`):
   * пара или герой. Новый герой - с именем и ролью кандидата, взятой из анализа на шаге выбора
   * (`F08-8b`); новая пара - с именем, без роли (условие заведения проверит импорт, `checkWorldPair`);
   * без имени или герой не кандидат хода - отказ. `within` - итог хода в той же транзакции.
   */
  private async write(
    bookVersionId: string,
    key: string,
    kind: WorldEntityKind,
    language: Language,
    state: EntityState | null,
    items: readonly WorldItem[],
    within: (tx: Prisma.TransactionClient) => Promise<void>,
  ): Promise<void> {
    // Ключ успели занять сущностью другого типа (место заводится импортом с `F08-12a`, во время хода):
    // ход не пишет поверх неё — иначе место молча стало бы героем. Отказ — как у остальных отказов
    // записи (`WORLD_WRITE_REFUSED`), по образцу `pairRefusal` (`pairKeyTaken`). Сверка
    // `expectedUpdatedAt`/`expectedAbsent` ниже перечитает состояние, если ключ заняли после чтения.
    if (state && state.entity.type !== kind.type) {
      throw new BadRequestException([
        `type: "${key}" is stored as a ${state.entity.type}; the run writes a ${kind.type}`,
      ]);
    }
    const body: Record<string, unknown> = { language, type: kind.type };
    if (!state) {
      const name = items.find((i) => i.name)?.name;
      if (!name) throw new BadRequestException(['name: a new entity needs a name']);
      body.name = name;
      if (kind.type === 'character') {
        if (!kind.role)
          throw new BadRequestException(['role: a new entity must be a candidate of the run']);
        body.role = kind.role;
      }
    }
    let sources = state?.entity.sources ?? null;
    for (const item of items) {
      body[item.block] = item.value;
      // Отпечаток «Внешности» едет вместе с ТЗ (решение `F08 | F08-11d-2`): из тела запроса его не взять.
      if (item.block === 'imageBrief' && item.basis) body.imageBriefFor = item.basis;
      if (item.sources && item.sources.length > 0) {
        sources = withWorldSources(sources, item.sources);
        // Список полон: внешний блок без своих проверенных источников не пишется (правило 6 канона).
        const kept = new Set(sources.map((s) => sourceKey(s.url)));
        if (!item.sources.every((s) => kept.has(sourceKey(s.url)))) {
          throw new BadRequestException([
            `sources: the list is full, the sources of ${item.block} do not fit`,
          ]);
        }
      }
    }
    // Список меняется, только если добавился адрес: иначе запись без `sources` не трогает поле.
    if ((sources?.length ?? 0) !== (state?.entity.sources?.length ?? 0)) body.sources = sources;
    await this.world.saveEntity(
      bookVersionId,
      key,
      body as unknown as UpdateBookWorldEntityDto,
      false,
      state ? { expectedUpdatedAt: state.updatedAt.toISOString() } : { expectedAbsent: 'true' },
      within,
    );
  }

  /**
   * «Accept» предложения: блок сущности не меняли после предложения (`WORLD_BLOCK_CHANGED` с `current`),
   * предложение то же, что читал редактор (`expectedPrint`). Запись блока и отметка `accepted` - одной
   * транзакцией импорта мира; под замком строки хода заново сверяется, что пункт всё ещё то же
   * предложение и не перегенерируется, - иначе запись откатывается. Блок уже равен предложению
   * (обрыв между записью и ответом) - только отметка. Отказ импорта - `WORLD_WRITE_REFUSED` с ошибками.
   */
  async accept(row: ContentDraft, index: number, expectedPrint?: string): Promise<void> {
    const data = await this.read(row, worldReadyGate);
    if (!data) throw notReady();
    const item = data.items[index];
    if (item?.outcome !== 'proposed') throw notProposed();
    if (item.regen) throw regenInProgress();
    const print = proposalPrint(item);
    if (expectedPrint !== undefined && expectedPrint !== print) {
      throw llmTaskConflict(WORLD_PROPOSAL_CHANGED, 'The proposal changed: read it again');
    }
    const markAccepted = async (tx: Prisma.TransactionClient) => {
      const current = await lockedData(tx, row, worldReadyGate);
      if (!current) throw notReady();
      const fresh = current.items[index];
      if (fresh?.outcome !== 'proposed') throw notProposed();
      if (fresh.regen) throw regenInProgress();
      if (proposalPrint(fresh) !== print) {
        throw llmTaskConflict(WORLD_PROPOSAL_CHANGED, 'The proposal changed: read it again');
      }
      await saveData(tx, row, withItem(current, index, { outcome: 'accepted' }));
    };
    for (let attempt = 1; ; attempt++) {
      const state = await this.entityState(row.bookVersionId, item.key);
      const current = state ? entityBlock(state.entity, item.block) : null;
      if (state && alreadyIn(state, item)) {
        await this.prisma.$transaction(markAccepted, DRAFT_TX_OPTIONS);
        return;
      }
      if (valuePrint(current) !== item.base) {
        throw llmTaskConflict(WORLD_BLOCK_CHANGED, 'The block changed after the proposal', {
          current,
        });
      }
      try {
        await this.write(
          row.bookVersionId,
          item.key,
          entityKindOf(data, item.key),
          row.language,
          state,
          [item],
          markAccepted,
        );
        return;
      } catch (error) {
        if (isRecordChanged(error) && attempt < WRITE_ATTEMPTS) continue;
        if (error instanceof BadRequestException) {
          const body = error.getResponse();
          throw llmTaskConflict(WORLD_WRITE_REFUSED, 'The world import refused the write', {
            errors:
              typeof body === 'object' && body !== null
                ? (body as { message?: unknown }).message
                : body,
          });
        }
        throw error;
      }
    }
  }

  /**
   * «Discard» предложения: сущность не трогается. Пункт на перегенерации - 409: её итог вернул бы
   * отброшенное предложение (как у хода анализа).
   */
  async discardItem(row: ContentDraft, index: number): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const current = await lockedData(tx, row, worldReadyGate);
      if (!current) throw notReady();
      const item = current.items[index];
      if (item?.outcome !== 'proposed') throw notProposed();
      if (item.regen) throw regenInProgress();
      await saveData(tx, row, withItem(current, index, { outcome: 'discarded' }));
    }, DRAFT_TX_OPTIONS);
  }
}

const notReady = () => llmTaskConflict(WORLD_WRITE_NOT_READY, 'The world run is not ready');
const notProposed = () => llmTaskConflict(WORLD_ITEM_NOT_PROPOSED, 'The block is not a proposal');
const regenInProgress = () =>
  llmTaskConflict(WORLD_REGEN_IN_PROGRESS, 'This block is being regenerated');

/** Данные хода под замком его строки; ход не прошёл `gate` - `null`. */
async function lockedData(
  tx: Prisma.TransactionClient,
  row: Pick<ContentDraft, 'id'>,
  gate: WorldGate,
): Promise<WorldWriteData | null> {
  await tx.$queryRaw`SELECT "id" FROM "ContentDraft" WHERE "id" = ${row.id} FOR UPDATE`;
  const fresh = await tx.contentDraft.findUnique({ where: { id: row.id } });
  if (!fresh) return null;
  const data = readWorldData(fresh.data);
  return passes(fresh, data, gate) ? data : null;
}

const saveData = (
  tx: Prisma.TransactionClient,
  row: Pick<ContentDraft, 'id'>,
  data: WorldWriteData,
) => tx.contentDraft.update({ where: { id: row.id }, data: { data: worldDataJson(data) } });

/**
 * Пункт уже в сущности (повтор после обрыва): блок равен значению и все проверенные источники пункта -
 * в списке сущности. Иначе запись нужна: у внешнего блока с тем же текстом могли быть новые источники.
 */
function alreadyIn(state: EntityState, item: WorldItem): boolean {
  if (valuePrint(entityBlock(state.entity, item.block)) !== valuePrint(item.value)) return false;
  // Тот же текст ТЗ по другой «Внешности» — не «уже записан»: отпечаток надо обновить (`F08 | F08-11d-2`).
  if (item.block === 'imageBrief' && item.basis && state.entity.imageBriefFor !== item.basis) {
    return false;
  }
  const stored = new Set((state.entity.sources ?? []).map((s) => sourceKey(s.url)));
  return (item.sources ?? []).every((s) => stored.has(sourceKey(s.url)));
}

/** Решения по пунктам - только тем, что всё ещё ждут (другой проход мог их уже решить). */
function withDecided(data: WorldWriteData, decided: ReadonlyMap<number, Partial<WorldItem>>) {
  let next = data;
  for (const [index, patch] of decided) {
    if (next.items[index]?.outcome === 'waiting') next = withItem(next, index, patch);
  }
  return next;
}

/**
 * Замок строк хода мира версии - снятие отметки перегенерации (`clearRegenMarkOf`): те же строки,
 * что берут `mutate`, «Accept» и «Discard», иначе снятие затёрло бы их запись (L-019).
 */
export async function lockWorldRuns(
  tx: Prisma.TransactionClient,
  bookVersionId: string,
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "ContentDraft"
    WHERE "bookVersionId" = ${bookVersionId} AND "kind" = 'world_write'::"ContentDraftKind"
    ORDER BY "id" FOR UPDATE`;
}

/** 409 сверки записи (`RECORD_CHANGED`): сущность изменили между чтением и записью - повтор. */
const isRecordChanged = (error: unknown): boolean =>
  error instanceof ConflictException && httpCode(error) === 'RECORD_CHANGED';
