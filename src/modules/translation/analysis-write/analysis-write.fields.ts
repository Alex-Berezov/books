import { BadRequestException, Injectable } from '@nestjs/common';
import { ContentDraft, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  BOOK_ANALYSIS_SELECT,
  EMPTY_BOOK_ANALYSIS,
  readStoredAnalysis,
  StoredBookAnalysis,
} from '../../book-analysis/book-analysis-data';
import { BOOK_ANALYSIS_TX_OPTIONS, lockBookAnalysis } from '../../book-analysis/book-analysis-lock';
import { BookAnalysisService } from '../../book-analysis/book-analysis.service';
import { BOOK_ANALYSIS_LIMITS } from '../../book-analysis/dto/book-analysis-blocks.dto';
import type { UpdateBookAnalysisDto } from '../../book-analysis/dto/update-book-analysis.dto';
import { compactBlock } from '../../author/author-page-data';
import { FillableFact } from '../content-draft/content-draft.analysis';
import { codeRemark } from '../draft-quality/text-checks';
import { blockOfPath, coreRemark } from './analysis-checks';
import { ANALYSIS_STEPS } from './analysis-write.constants';
import {
  ANALYSIS_TARGETS,
  analysisDataJson,
  AnalysisItem,
  AnalysisStepNumber,
  AnalysisTarget,
  AnalysisWriteData,
  blockPrint,
  readAnalysisData,
  stableJson,
  StepFix,
  targetValue,
} from './analysis-write.data';
import { quotePrint } from './analysis-write.steps';

type Db = Prisma.TransactionClient;

/**
 * Чья запись идёт: ход `building` своей операции. Не совпало - ход отбросили, отменили или он
 * кончился: ничего не пишется (`L-019`). Под замком строка хода берётся `FOR UPDATE`, а данные
 * пишутся условием `status = 'building'` той же операции: отмена со страницы операций
 * (`onCancelled`) ждёт коммита записи шага и не проскакивает между проверкой и записью.
 * Решения редактора по ходу `ready` - `F07-1b`.
 */
export interface AnalysisGate {
  operationId: string;
  allows: (row: ContentDraft) => boolean;
}

export const analysisRunGate = (operationId: string): AnalysisGate => ({
  operationId,
  allows: (row) => row.status === 'building' && row.operationId === operationId,
});

/** Строка хода больше не принимает запись этой операции: транзакция откатывается. */
class AnalysisRunGone extends Error {
  constructor() {
    super('The analysis run no longer takes this write');
    this.name = 'AnalysisRunGone';
  }
}

/** Итог правки данных хода: `written: false` - `fn` отказался писать (`null`). */
interface MutateResult {
  data: AnalysisWriteData;
  written: boolean;
}

/**
 * Отказ проверки ссылок на итоговой записи (решение арбитра `F07 | F07-1a`, К4): блоки первого
 * сегмента путей ошибок уходят предложением с `IMPORT_INVALID` и путём, остальные пишутся
 * повторной записью.
 */
interface Refusal {
  blocks: ReadonlySet<string>;
  errors: readonly string[];
}

/** Блоки версии под замком: решение «записать или предложить» читает их, а не копию. */
interface BlockState {
  stored: StoredBookAnalysis;
  published: boolean;
}

/** Решение по ждущим блокам шага: что пишется одной записью импорта, что - предложением. */
interface StepPlan {
  dto: UpdateBookAnalysisDto | null;
  /** Индекс элемента → содержимое (у `themeKeys` шага 3 - собранное здесь). */
  values: Map<number, unknown>;
  writes: number[];
  proposals: number[];
  /** Связям тем некуда влиться (героев или цитат нет, совпадений нет): элемент снимается. */
  empty: number[];
  /** Предложения из-за отказа проверки ссылок (К4): индекс → ошибки. */
  refused: Map<number, string[]>;
  /** `themeKeys` сверх предела импорта после слияния - отрезаны (`LIMIT_OUT`). */
  cut: StepFix[];
}

const factField = (target: AnalysisTarget): FillableFact | null =>
  target.startsWith('facts.') ? (target.slice('facts.'.length) as FillableFact) : null;

/** Блок анализа единицы записи: `facts.<подполе>` - блок `facts`. */
const blockOfTarget = (target: AnalysisTarget): string =>
  target.startsWith('facts.') ? 'facts' : target;

/**
 * Ход вправе писать блок (`tech.md` §5): право на старте, версия не опубликована, и блок с
 * последней записи хода никто не менял - его отпечаток совпадает с `written`.
 */
export function writable(
  data: AnalysisWriteData,
  target: AnalysisTarget,
  state: BlockState,
): boolean {
  return (
    data.owns[target] === true &&
    !state.published &&
    data.written[target] === blockPrint(targetValue(state.stored, target))
  );
}

/**
 * `themeKeys` шага 3 поверх сохранённого блока (`characters` по ключу, `keyQuotes` по отпечатку
 * текста): только ключи записанных тем, без повторов, в предел импорта - лишнее отрезано
 * (`LIMIT_OUT`). Ничего не изменилось - `null`.
 */
function linkThemes<T extends { themeKeys?: string[] | null }>(
  base: readonly T[],
  idOf: (element: T) => string,
  links: Record<string, string[]>,
  themeKeys: ReadonlySet<string>,
  block: string,
  cut: StepFix[],
): T[] | null {
  const max = BOOK_ANALYSIS_LIMITS.themeKeys;
  let changed = false;
  const out = base.map((element) => {
    const id = idOf(element);
    const keys = (links[id] ?? []).filter((key) => themeKeys.has(key));
    if (keys.length === 0) return element;
    const merged = [...new Set([...(element.themeKeys ?? []), ...keys])];
    if (merged.length > max) {
      cut.push({
        code: 'LIMIT_OUT',
        path: `${block}.${id}.themeKeys`,
        note: `${merged.length - max} of ${merged.length} cut: the import takes at most ${max}`,
      });
    }
    const next = merged.slice(0, max);
    if (stableJson(next) === stableJson(element.themeKeys ?? [])) return element;
    changed = true;
    return { ...element, themeKeys: next };
  });
  return changed ? out : null;
}

/**
 * Решение по ждущим блокам шага (`tech.md` §5): блок, который ход вправе писать, - в тело импорта;
 * остальное - предложение. `themeKeys` шага 3 (`tech.md` §2) вливаются в сохранённые `characters`
 * и `keyQuotes` только ключами тем, которые после этой записи есть в анализе: тема ушла в
 * предложение - её ключ не вливается. `facts` собирается целиком: сохранённые подполя и подполя
 * хода (импорт заменяет блок целиком). Блоки `refusal` (К4) - предложения с ошибками.
 */
export function planStep(
  data: AnalysisWriteData,
  step: AnalysisStepNumber,
  state: BlockState,
  language: Language,
  refusal: Refusal | null = null,
): StepPlan {
  const plan: StepPlan = {
    dto: null,
    values: new Map(),
    writes: [],
    proposals: [],
    empty: [],
    refused: new Map(),
    cut: [],
  };
  const waiting = data.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.step === step && item.outcome === 'waiting');
  const refusedBlock = (target: AnalysisTarget): boolean =>
    refusal !== null && refusal.blocks.has(blockOfTarget(target));
  const canWrite = (target: AnalysisTarget): boolean =>
    writable(data, target, state) && !refusedBlock(target);
  const themesItem = waiting.find(({ item }) => !item.links && item.target === 'themes');
  const themeKeys = new Set(
    (themesItem !== undefined && canWrite('themes')
      ? (themesItem.item.value as Array<{ key: string }>)
      : (state.stored.themes ?? [])
    ).map((theme) => theme.key),
  );
  const links = data.themeLinks ?? { characters: {}, keyQuotes: {} };
  for (const { item, index } of waiting) {
    let value: unknown = item.value;
    if (item.links) {
      value =
        item.target === 'characters'
          ? linkThemes(
              state.stored.characters ?? [],
              (character) => character.key,
              links.characters,
              themeKeys,
              'characters',
              plan.cut,
            )
          : linkThemes(
              state.stored.keyQuotes ?? [],
              (quote) => quotePrint(quote.text),
              links.keyQuotes,
              themeKeys,
              'keyQuotes',
              plan.cut,
            );
      if (value === null) {
        plan.empty.push(index);
        continue;
      }
    }
    plan.values.set(index, value);
    if (canWrite(item.target)) {
      plan.writes.push(index);
      continue;
    }
    plan.proposals.push(index);
    if (refusal !== null && refusedBlock(item.target)) {
      const block = blockOfTarget(item.target);
      plan.refused.set(
        index,
        refusal.errors.filter((error) => blockOfPath(error) === block),
      );
    }
  }
  if (plan.writes.length === 0) return plan;
  const body: Record<string, unknown> = { language };
  for (const index of plan.writes) {
    const target = data.items[index].target;
    const field = factField(target);
    if (field) {
      const facts = (body.facts ?? { ...(state.stored.facts ?? {}) }) as Record<string, unknown>;
      facts[field] = plan.values.get(index);
      body.facts = facts;
    } else {
      body[target] = plan.values.get(index);
    }
  }
  plan.dto = body as unknown as UpdateBookAnalysisDto;
  return plan;
}

/**
 * Решение то же: тело записи, разбиение и **значения** - у предложения `themeKeys` значение
 * собрано из блоков версии, и под замком они должны быть те же, что у решения без замка.
 */
function samePlan(a: StepPlan, b: StepPlan): boolean {
  const form = (plan: StepPlan) =>
    stableJson({
      dto: plan.dto,
      values: [...plan.values],
      writes: plan.writes,
      proposals: plan.proposals,
      empty: plan.empty,
      refused: [...plan.refused],
      cut: plan.cut,
    });
  return form(a) === form(b);
}

/** Сколько раз решение пересобирается, если блоки поменялись между чтением и замком. */
export const PLAN_ATTEMPTS = 3;

export type SettleOutcome = 'settled' | 'gone';

/** Ошибки отказа проверки ссылок (`validateMerged`): `<путь>: <сообщение>`. */
function refusalErrors(error: BadRequestException): string[] {
  const body = error.getResponse() as { message?: unknown };
  const message = body.message;
  if (Array.isArray(message)) return message.filter((m): m is string => typeof m === 'string');
  return [typeof message === 'string' ? message : error.message];
}

/**
 * Запись хода анализа в блоки версии (`features/F07-analysis-autofill/tech.md` §5): решение и
 * запись - в одной транзакции под замком анализа, тем же телом, что импорт `F03`
 * (`BookAnalysisService.saveGuarded`, решение арбитра `F07 | F07-1`, В5). Данные хода тоже пишутся
 * только под этим замком и под замком своей строки.
 */
@Injectable()
export class AnalysisWriteFields {
  constructor(
    private readonly prisma: PrismaService,
    private readonly analyses: BookAnalysisService,
  ) {}

  /** Блоки версии; `lock` - строка версии `FOR NO KEY UPDATE`: публикация не проскочит до записи. */
  async state(tx: Db, bookVersionId: string, lock = false): Promise<BlockState> {
    if (lock) {
      await tx.$queryRaw`SELECT "id" FROM "BookVersion" WHERE "id" = ${bookVersionId} FOR NO KEY UPDATE`;
    }
    const [version, row] = await Promise.all([
      tx.bookVersion.findUnique({ where: { id: bookVersionId }, select: { status: true } }),
      tx.bookAnalysis.findUnique({ where: { bookVersionId }, select: BOOK_ANALYSIS_SELECT }),
    ]);
    return {
      published: version?.status === 'published',
      stored: row ? readStoredAnalysis(row) : EMPTY_BOOK_ANALYSIS,
    };
  }

  /** Право хода на блоки и отпечатки блоков на старте (`tech.md` §5); `tx` - под замком анализа. */
  async ownership(
    tx: Db,
    bookVersionId: string,
  ): Promise<Pick<AnalysisWriteData, 'owns' | 'written'>> {
    const state = await this.state(tx, bookVersionId);
    const owns: AnalysisWriteData['owns'] = {};
    const written: AnalysisWriteData['written'] = {};
    for (const target of ANALYSIS_TARGETS) {
      const value = targetValue(state.stored, target);
      // Пусто - как у импорта (`mergeAnalysis` пишет через `compactBlock`): нет блока после сжатия.
      owns[target] = !state.published && compactBlock(value) === null;
      written[target] = blockPrint(value);
    }
    return { owns, written };
  }

  /** Данные хода без замка - только для чтения перед решением под замком. */
  async read(row: Pick<ContentDraft, 'id'>, gate: AnalysisGate): Promise<AnalysisWriteData | null> {
    const found = await this.prisma.contentDraft.findUnique({ where: { id: row.id } });
    if (!found || found.kind !== 'analysis_write' || !gate.allows(found)) return null;
    return readAnalysisData(found.data);
  }

  /**
   * Правка данных хода под замком анализа и строки; `fn` получает `tx` этой транзакции - чтение
   * анализа под тем же замком; `fn` вернул `null` - не писать (`written: false`); не прошёл
   * `gate` - `null`.
   */
  async mutate(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: AnalysisGate,
    fn: (
      data: AnalysisWriteData,
      tx: Db,
    ) => AnalysisWriteData | null | Promise<AnalysisWriteData | null>,
  ): Promise<MutateResult | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, row.bookVersionId);
        const current = await this.locked(tx, row.id, gate);
        if (!current) return null;
        const next = await fn(current, tx);
        if (!next) return { data: current, written: false };
        await this.save(tx, row.id, gate, next);
        return { data: next, written: true };
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      if (error instanceof AnalysisRunGone) return null;
      throw error;
    }
  }

  /**
   * `CORE_MISSING` после шага 3 (К5): по анализу, прочитанному под замком анализа в той же
   * транзакции, что запись флага (Б3, `L-019`), - флаг шага 3, и для упавшего шага 3 тоже; прежний
   * флаг снимается. Идемпотентно: повтор после обрыва ставит тот же флаг. `null` - ход больше
   * не принимает запись.
   */
  async markCore(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: AnalysisGate,
  ): Promise<true | null> {
    const saved = await this.mutate(row, gate, async (data, tx) => {
      const remark = coreRemark((await this.state(tx, row.bookVersionId)).stored);
      return {
        ...data,
        steps: data.steps.map((s) => {
          if (s.step !== ANALYSIS_STEPS) return s;
          const remarks = [...s.remarks.filter((r) => r.code !== 'CORE_MISSING')];
          if (remark) remarks.push(remark);
          const verdict = s.outcome === 'failed' ? 'failed' : remark ? 'flags' : s.verdict;
          return { ...s, remarks, verdict };
        }),
      };
    });
    return saved ? true : null;
  }

  /**
   * Ждущие блоки шага - в анализ или в предложения (`tech.md` §5). Решение собирается по чтению
   * без замка и под замком сверяется заново вместе со значениями: разошлось - пересборка. Отказ
   * проверки ссылок (К4): блоки путей ошибок - предложения с `IMPORT_INVALID`, остальные -
   * повторная запись в тех же `PLAN_ATTEMPTS`; путь вне записи или второй отказ - всё
   * предложениями. Версию удалили - исключение наружу.
   */
  async settleStep(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
  ): Promise<SettleOutcome> {
    let refusal: Refusal | null = null;
    for (let attempt = 0; attempt < PLAN_ATTEMPTS; attempt++) {
      const data = await this.read(row, gate);
      if (!data) return 'gone';
      const plan = planStep(
        data,
        step,
        await this.state(this.prisma, row.bookVersionId),
        row.language,
        refusal,
      );
      if (plan.dto === null) {
        const done = await this.settleWithout(row, gate, step, 'plain', refusal);
        if (done !== 'replan') return done;
        continue;
      }
      const dto = plan.dto;
      const attemptRefusal = refusal;
      // Держатель, а не `let`: присваивания в замыканиях сужение типа не видит.
      const result: { outcome: SettleOutcome | 'replan'; existing: StoredBookAnalysis } = {
        outcome: 'replan',
        existing: EMPTY_BOOK_ANALYSIS,
      };
      try {
        await this.analyses.saveGuarded(row.bookVersionId, dto, {
          allow: async (tx, before) => {
            result.existing = before;
            const current = await this.locked(tx, row.id, gate);
            if (!current) {
              result.outcome = 'gone';
              return false;
            }
            const published = (await this.state(tx, row.bookVersionId, true)).published;
            const again = planStep(
              current,
              step,
              { stored: before, published },
              row.language,
              attemptRefusal,
            );
            return samePlan(plan, again);
          },
          done: async (tx, saved) => {
            const current = await this.locked(tx, row.id, gate);
            if (!current) throw new AnalysisRunGone();
            const next = applyPlan(current, step, plan, result.existing, saved);
            await this.save(tx, row.id, gate, next);
            result.outcome = 'settled';
          },
        });
      } catch (error) {
        if (error instanceof AnalysisRunGone) return 'gone';
        if (!(error instanceof BadRequestException)) throw error;
        const errors = refusalErrors(error);
        const written = new Set(Object.keys(dto).filter((key) => key !== 'language'));
        const blocks = new Set(errors.map(blockOfPath));
        const outside = [...blocks].some((block) => !written.has(block));
        if (refusal !== null || outside) {
          return this.finalWithout(row, gate, step, { blocks: written, errors });
        }
        refusal = { blocks, errors };
        continue;
      }
      if (result.outcome !== 'replan') return result.outcome;
    }
    // Блоки меняют быстрее, чем ход решает: всё ждущее - предложением, без записи.
    return this.finalWithout(row, gate, step, refusal);
  }

  private async finalWithout(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    refusal: Refusal | null,
  ): Promise<SettleOutcome> {
    const done = await this.settleWithout(row, gate, step, 'force', refusal);
    return done === 'replan' ? 'settled' : done;
  }

  /**
   * Шаг без записи блоков: только предложения, решение собирается под замком из блоков,
   * прочитанных под ним. `plain` - появилась запись - `replan`; `force` - всё предложением (версия
   * как опубликованная), блоки, которые иначе писались бы, - с ошибками отказа `refusal`.
   */
  private async settleWithout(
    row: Pick<ContentDraft, 'id' | 'bookVersionId' | 'language'>,
    gate: AnalysisGate,
    step: AnalysisStepNumber,
    kind: 'plain' | 'force',
    refusal: Refusal | null,
  ): Promise<SettleOutcome | 'replan'> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        await lockBookAnalysis(tx, row.bookVersionId);
        const current = await this.locked(tx, row.id, gate);
        if (!current) return 'gone';
        const state = await this.state(tx, row.bookVersionId, true);
        const real = planStep(current, step, state, row.language, refusal);
        if (kind === 'plain' && real.dto !== null) return 'replan';
        const all =
          kind === 'force'
            ? planStep(current, step, { ...state, published: true }, row.language, refusal)
            : real;
        if (kind === 'force' && refusal !== null) {
          for (const index of real.writes) all.refused.set(index, [...refusal.errors]);
        }
        await this.save(tx, row.id, gate, applyPlan(current, step, all, state.stored, null));
        return 'settled';
      }, BOOK_ANALYSIS_TX_OPTIONS);
    } catch (error) {
      if (error instanceof AnalysisRunGone) return 'gone';
      throw error;
    }
  }

  /** Строка хода под замком `FOR UPDATE` в транзакции `tx`; не прошла `gate` - `null`. */
  private async locked(tx: Db, id: string, gate: AnalysisGate): Promise<AnalysisWriteData | null> {
    await tx.$queryRaw`SELECT "id" FROM "ContentDraft" WHERE "id" = ${id} FOR UPDATE`;
    const row = await tx.contentDraft.findUnique({ where: { id } });
    if (!row || row.kind !== 'analysis_write' || !gate.allows(row)) return null;
    return readAnalysisData(row.data);
  }

  /** Данные хода - условием своей операции и `building`: не совпало - откат транзакции. */
  private async save(tx: Db, id: string, gate: AnalysisGate, data: AnalysisWriteData) {
    const { count } = await tx.contentDraft.updateMany({
      where: { id, status: 'building', operationId: gate.operationId },
      data: { data: analysisDataJson(data) },
    });
    if (count !== 1) throw new AnalysisRunGone();
  }
}

/**
 * Итог решения в данных хода: записанные - `written` и отпечаток блока, перечитанного из базы
 * после записи (Л2); предложения - отпечаток блока до записи, прочитанного под замком: «Accept»
 * сверит содержимое (`tech.md` §5); отказ проверки ссылок (К4) - замечание `IMPORT_INVALID`
 * с путём каждой ошибки; отрезанные `themeKeys` - в правки шага (`LIMIT_OUT`).
 */
export function applyPlan(
  data: AnalysisWriteData,
  step: AnalysisStepNumber,
  plan: StepPlan,
  before: StoredBookAnalysis,
  saved: StoredBookAnalysis | null,
): AnalysisWriteData {
  const items = [...data.items];
  const written = { ...data.written };
  const patch = (index: number, change: Partial<AnalysisItem>) => {
    items[index] = { ...items[index], ...change };
  };
  for (const index of plan.writes) {
    const target = items[index].target;
    const value = saved ? targetValue(saved, target) : plan.values.get(index);
    written[target] = blockPrint(value);
    patch(index, { outcome: 'written', hash: null, value: plan.values.get(index) ?? null });
  }
  for (const index of plan.proposals) {
    const item = items[index];
    const errors = plan.refused.get(index);
    const remarks = errors
      ? [
          ...item.remarks,
          ...errors.map((error) =>
            codeRemark(
              'IMPORT_INVALID',
              error.split(':', 1)[0],
              `The analysis refused this write: ${error}`,
            ),
          ),
        ]
      : item.remarks;
    patch(index, {
      outcome: 'proposed',
      hash: blockPrint(targetValue(before, item.target)),
      value: plan.values.get(index) ?? null,
      remarks,
      verdict: errors ? 'flags' : item.verdict,
    });
  }
  for (const index of plan.empty) patch(index, { outcome: 'none', value: null });
  const steps =
    plan.cut.length === 0
      ? data.steps
      : data.steps.map((s) =>
          s.step === step ? { ...s, dropped: [...s.dropped, ...plan.cut] } : s,
        );
  return { ...data, steps, items, written };
}
