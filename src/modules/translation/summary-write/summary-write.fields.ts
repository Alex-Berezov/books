import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ContentDraft, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { withSummaryLock } from '../../book-summary/book-summary-lock';
import { BookSummaryService } from '../../book-summary/book-summary.service';
import {
  BookSummarySectionsService,
  SectionWriteMode,
} from '../../book-summary/book-summary-sections.service';
import { SUMMARY_SECTION_LIMITS } from '../../book-summary/dto/create-book-summary-section.dto';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { summaryHtml } from './summary-html';
import {
  SUMMARY_CHAPTER_CHANGE,
  SUMMARY_FIELD_CHANGED,
  SUMMARY_ITEM_NOT_PROPOSED,
  SUMMARY_FULL_UNFINISHED,
  SUMMARY_REGEN_IN_PROGRESS,
  SUMMARY_WRITE_REFUSED,
} from './summary-write.constants';
import {
  fieldPrint,
  readWriteData,
  sectionPrint,
  SummaryWriteData,
  toJson,
  withItem,
  WriteItem,
} from './summary-write.data';

type Db = Prisma.TransactionClient;

type VersionSection = { number: number; title: string; text: string; readerChapter: number | null };

/** Поля пересказа версии под замком: решение «записать или предложить» читает их, а не копию. */
export interface FieldState {
  published: boolean;
  summary: string | null;
  brief: string | null;
  hasText: boolean;
  briefHasText: boolean;
  sections: VersionSection[];
  /** Номер последней главы версии; глав нет - `null` (охват последнего раздела, В3). */
  lastChapter: number | null;
}

/**
 * Чья запись идёт: ход (`building` и своя операция), перегенерация его текста (`ready` и операция
 * перегенерации этого текста, решение арбитра `F06 | F06-2`, Р2) или решение редактора по ходу
 * `ready`. Не совпало - строку отбросили или перегенерацию сняли: ничего не пишется (`L-019`).
 * `regen` - запись перегенерации: текст, уже записанный в поле, она меняет только предложением
 * (круг 1, В2).
 */
export interface DraftGate {
  allows: (row: ContentDraft, data: SummaryWriteData) => boolean;
  regen: boolean;
}

export const runGate = (operationId: string): DraftGate => ({
  allows: (row) => row.status === 'building' && row.operationId === operationId,
  regen: false,
});

export const regenGate = (operationId: string, index: number): DraftGate => ({
  allows: (row, data) =>
    row.status === 'ready' && data.items[index]?.regen?.operationId === operationId,
  regen: true,
});

/** Ход `ready` - решения редактора по его текстам (`tech.md` §5). */
export const readyGate: DraftGate = { allows: (row) => row.status === 'ready', regen: false };

export type SettleOutcome = 'written' | 'proposed' | 'waiting' | 'gone';

/** Отпечаток разделов версии, бывших при предложении «в конец» (решение арбитра, круг 1, В1). */
const basePrint = (sections: readonly VersionSection[]): string =>
  fieldPrint('append', ...sections.map((s) => sectionPrint(s)));

const fieldValue = (state: FieldState, target: 'full' | 'brief'): string | null =>
  target === 'full' ? state.summary : state.brief;

const fieldHasText = (state: FieldState, target: 'full' | 'brief'): boolean =>
  target === 'full' ? state.hasText : state.briefHasText;

/** Поля менял только этот ход: разделы версии - ровно записанные ходом и с его отпечатками. */
function sectionsIntact(data: SummaryWriteData, state: FieldState): boolean {
  const written = data.written.sections;
  if (Object.keys(written).length !== state.sections.length) return false;
  return state.sections.every((s) => written[String(s.number)] === sectionPrint(s));
}

type SectionDecision =
  | { kind: 'write'; mode: SectionWriteMode }
  | { kind: 'waiting' }
  | { kind: 'propose'; patch: Partial<WriteItem> };

/** Предложение раздела: замена раздела того же номера или «в конец» (`tech.md` §5, В1). */
function sectionProposal(item: WriteItem, state: FieldState): Partial<WriteItem> {
  const own = state.sections.find((s) => s.number === item.number);
  return own
    ? { fieldMode: 'replace', fieldHash: sectionPrint(own), fieldBase: null }
    : {
        fieldMode: 'append',
        fieldHash: basePrint(state.sections),
        fieldBase: state.sections.map((s) => sectionPrint(s)),
      };
}

/**
 * Раздел хода (`tech.md` §5, решения арбитра `F06 | F06-2`, Р1, круг 1 В2): ход владеет разделами,
 * версия не опубликована и разделы менял только он - раздел пишется под номером плана строго по
 * порядку; свой записанный раздел ход на `building` заменяет, перегенерация - только предложением;
 * раздел плана перед ним текста не получил - ждёт; иначе - предложение.
 */
function sectionDecision(
  data: SummaryWriteData,
  item: WriteItem,
  state: FieldState,
  regen: boolean,
): SectionDecision {
  const number = item.number as number;
  const own = state.sections.find((s) => s.number === number);
  if (data.owns.sections && !state.published && sectionsIntact(data, state)) {
    if (own && !regen) return { kind: 'write', mode: { kind: 'replace', number } };
    if (!own && state.sections.length === number - 1) {
      return { kind: 'write', mode: { kind: 'append' } };
    }
    if (!own && state.sections.length < number - 1) return { kind: 'waiting' };
  }
  return { kind: 'propose', patch: sectionProposal(item, state) };
}

/**
 * Полный и «Очень кратко»: право хода на поле, версия не опубликована, поле менял только ход;
 * перегенерация пишет прямо только в поле, пустое сейчас (круг 1, В2).
 */
function textDecision(
  data: SummaryWriteData,
  item: WriteItem,
  state: FieldState,
  regen: boolean,
): { write: true } | { write: false; fieldHash: string } {
  const target = item.target as 'full' | 'brief';
  const current = fieldPrint(fieldValue(state, target));
  const intact = data.written[target] === current;
  // «Очень кратко» без полного с текстом не пишется (`upsertBrief`): предложение.
  const writable = target === 'full' || state.hasText;
  const empty = !regen || !fieldHasText(state, target);
  // «Очень кратко» хода построено по полному хода: прямо - только если и полный хода в поле,
  // иначе блок пересказывал бы текст, которого в версии нет (решение арбитра, круг 2). Своя
  // перегенерация «Очень кратко» строится по сохранённому полному - условие к ней не относится.
  const ofField =
    target !== 'brief' ||
    item.regen !== null ||
    data.items.some((i) => i.target === 'full' && i.outcome === 'written');
  return data.owns[target] && !state.published && intact && writable && empty && ofField
    ? { write: true }
    : { write: false, fieldHash: current };
}

/** Содержимое раздела из текста хода: HTML по правилу подзаголовка, название - в предел F04. */
function sectionContent(item: WriteItem) {
  return {
    title: (item.title ?? '').slice(0, SUMMARY_SECTION_LIMITS.title),
    text: summaryHtml(item.text),
    readerChapter: item.readerChapter,
  };
}

/**
 * Выведенный охват раздела версии (решение арбитра, круг 1, В3): от его главы читалки до главы
 * перед главой следующего раздела, у последнего - до последней главы версии. Глава неизвестна или
 * главы разделов идут не по возрастанию - `null` (охват не вывести, деление считается иным).
 */
export function sectionCoverage(
  state: Pick<FieldState, 'sections' | 'lastChapter'>,
  number: number,
): { from: number; to: number } | null {
  const at = state.sections.findIndex((s) => s.number === number);
  if (at < 0) return null;
  const from = state.sections[at].readerChapter;
  const next = state.sections[at + 1];
  const to = next
    ? next.readerChapter === null
      ? null
      : next.readerChapter - 1
    : state.lastChapter;
  return from === null || to === null || to < from ? null : { from, to };
}

/** Главы плана подряд - охват предложения; не подряд - `null`. */
function planCoverage(chapters: readonly number[] | null): { from: number; to: number } | null {
  if (!chapters || chapters.length === 0) return null;
  const sorted = [...chapters].sort((a, b) => a - b);
  const contiguous = sorted.every((c, i) => i === 0 || c === sorted[i - 1] + 1);
  return contiguous ? { from: sorted[0], to: sorted[sorted.length - 1] } : null;
}

/** Иное деление у замены раздела того же номера: охваты не равны или не выводятся (В3). */
export function chapterChanged(
  item: Pick<WriteItem, 'chapters'>,
  state: Pick<FieldState, 'sections' | 'lastChapter'>,
  number: number,
): boolean {
  const was = sectionCoverage(state, number);
  const will = planCoverage(item.chapters);
  return was === null || will === null || was.from !== will.from || was.to !== will.to;
}

const range = (c: { from: number; to: number } | null) =>
  c === null
    ? 'unknown chapters'
    : c.from === c.to
      ? `chapter ${c.from}`
      : `chapters ${c.from}–${c.to}`;

/**
 * Запись хода пересказа в поля версии (`features/F06-summary-autofill/tech.md` §5): решение и
 * запись - в одной транзакции под замком пересказа (`L-019`), тем же телом, что ручки Summary
 * (`writeGuarded`): нумерация, `hasText` и `briefHasText` считаются там одни.
 */
@Injectable()
export class SummaryWriteFields {
  constructor(
    private readonly prisma: PrismaService,
    private readonly summaries: BookSummaryService,
    private readonly sections: BookSummarySectionsService,
  ) {}

  /**
   * Поля пересказа версии. `lock` - решение о записи: строка версии берётся `FOR NO KEY UPDATE`
   * (исключает `UPDATE` публикации, не мешает вставкам дочерних строк по внешнему ключу) в той же
   * транзакции, что запись, - публикация (`BookVersion.status`) идёт мимо замка пересказа и иначе
   * успела бы между чтением статуса и записью (решение арбитра, круг 3).
   */
  async state(tx: Db, bookVersionId: string, lock = false): Promise<FieldState> {
    if (lock) {
      await tx.$queryRaw`SELECT "id" FROM "BookVersion" WHERE "id" = ${bookVersionId} FOR NO KEY UPDATE`;
    }
    const [version, summary, sections, last] = await Promise.all([
      tx.bookVersion.findUnique({ where: { id: bookVersionId }, select: { status: true } }),
      tx.bookSummary.findUnique({
        where: { bookVersionId },
        select: { summary: true, brief: true, hasText: true, briefHasText: true },
      }),
      tx.bookSummarySection.findMany({
        where: { bookVersionId },
        orderBy: { number: 'asc' },
        select: { number: true, title: true, text: true, readerChapter: true },
        take: SUMMARY_SECTION_LIMITS.sectionsPerVersion,
      }),
      tx.chapter.findFirst({
        where: { bookVersionId },
        orderBy: { number: 'desc' },
        select: { number: true },
      }),
    ]);
    return {
      published: version?.status === 'published',
      summary: summary?.summary ?? null,
      brief: summary?.brief ?? null,
      hasText: summary?.hasText ?? false,
      briefHasText: summary?.briefHasText ?? false,
      sections,
      lastChapter: last?.number ?? null,
    };
  }

  /** Данные хода без замка - только для чтения перед решением под замком. */
  async read(row: Pick<ContentDraft, 'id'>, gate: DraftGate): Promise<SummaryWriteData | null> {
    return (await this.locked(this.prisma, row.id, gate))?.data ?? null;
  }

  /**
   * Правка данных хода под замком пересказа: все записи данных хода идут под ним, поэтому ход и
   * его перегенерации не теряют чужих строк. `fn` вернул `null` - не писать. Не прошёл `gate` - `null`.
   */
  async mutate(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: DraftGate,
    fn: (data: SummaryWriteData) => SummaryWriteData | null,
  ): Promise<SummaryWriteData | null> {
    return withSummaryLock(this.prisma, row.bookVersionId, async (tx) => {
      const current = await this.locked(tx, row.id, gate);
      if (!current) return null;
      const next = fn(current.data);
      if (next) await this.save(tx, row.id, next);
      return next ?? current.data;
    });
  }

  /**
   * Текст хода `index` в поле или в предложение (`tech.md` §5). Раздел, записанный прямо, будит
   * ждущие разделы после себя по порядку (Р1).
   */
  async settle(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: DraftGate,
    index: number,
  ): Promise<SettleOutcome> {
    const { outcome, data } = await this.settleOne(row, gate, index);
    if (outcome !== 'written' || data?.items[index]?.target !== 'section') return outcome;
    for (const [i, next] of data.items.entries()) {
      if (next.target !== 'section' || next.outcome !== 'waiting') continue;
      // Дальше по порядку можно только после записанного; предложение порядок не держит.
      const woke = (await this.settleOne(row, gate, i)).outcome;
      if (woke === 'waiting' || woke === 'gone') break;
    }
    return outcome;
  }

  private async settleOne(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: DraftGate,
    index: number,
  ): Promise<{ outcome: SettleOutcome; data: SummaryWriteData | null }> {
    let outcome: SettleOutcome = 'gone';
    let data: SummaryWriteData | null = null;
    const item = (await this.read(row, gate))?.items[index];
    if (!item) return { outcome, data };
    // Под замком - тот же ждущий текст: «Discard» или «Accept» между чтением и замком его уже
    // решили, и писать нечего (L-019; решение арбитра, круг 3).
    const stillWaiting = (current: { data: SummaryWriteData } | null) =>
      current !== null && current.data.items[index]?.outcome === 'waiting';
    try {
      return await this.settleLocked(
        row,
        gate,
        index,
        item,
        stillWaiting,
        (next) => {
          data = next;
        },
        (o) => {
          outcome = o;
        },
      ).then(() => ({ outcome, data }));
    } catch (error) {
      // Отказ записи сервиса пересказа (номер занят мимо сервиса, версию удалили) - конечный исход
      // «не записано», а не пауза шага по кругу (решение арбитра, круг 3).
      if (
        error instanceof ConflictException ||
        error instanceof NotFoundException ||
        error instanceof BadRequestException
      ) {
        // Причина - в тексте хода: иначе он остался бы «ждущим» и пробовался на каждом шаге (круг 4).
        await this.mutate(row, gate, (current) =>
          withItem(current, index, { outcome: 'none', failedReason: SUMMARY_WRITE_REFUSED }),
        );
        return { outcome: 'gone', data: null };
      }
      throw error;
    }
  }

  private async settleLocked(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    gate: DraftGate,
    index: number,
    item: WriteItem,
    stillWaiting: (current: { data: SummaryWriteData } | null) => boolean,
    setData: (data: SummaryWriteData) => void,
    setOutcome: (outcome: SettleOutcome) => void,
  ): Promise<void> {
    const keep = async (tx: Db, next: SummaryWriteData) => {
      await this.save(tx, row.id, next);
      setData(next);
    };
    if (item.target === 'section') {
      await this.sections.writeGuarded(row.bookVersionId, sectionContent(item), {
        decide: async (tx) => {
          const current = await this.locked(tx, row.id, gate);
          if (!current || !stillWaiting(current)) return null;
          const state = await this.state(tx, row.bookVersionId, true);
          const decision = sectionDecision(
            current.data,
            current.data.items[index],
            state,
            gate.regen,
          );
          if (decision.kind === 'write') return decision.mode;
          setOutcome(decision.kind === 'waiting' ? 'waiting' : 'proposed');
          const patch: Partial<WriteItem> =
            decision.kind === 'propose'
              ? { outcome: 'proposed', ...decision.patch }
              : { outcome: 'waiting', fieldHash: null, fieldMode: null, fieldBase: null };
          await keep(tx, withItem(current.data, index, patch));
          return null;
        },
        done: async (tx, number) => {
          const current = await this.locked(tx, row.id, gate);
          if (!current) return;
          const written = (await this.state(tx, row.bookVersionId)).sections.find(
            (s) => s.number === number,
          );
          const next = withItem(current.data, index, {
            outcome: 'written',
            fieldHash: null,
            fieldMode: null,
            fieldBase: null,
          });
          if (written) next.written.sections[String(number)] = sectionPrint(written);
          await keep(tx, next);
          setOutcome('written');
        },
      });
      return;
    }
    const target = item.target;
    await this.summaries.writeGuarded(row.bookVersionId, target, summaryHtml(item.text), {
      allow: async (tx) => {
        const current = await this.locked(tx, row.id, gate);
        if (!current || !stillWaiting(current)) return false;
        const state = await this.state(tx, row.bookVersionId, true);
        const decision = textDecision(current.data, current.data.items[index], state, gate.regen);
        if (decision.write) return true;
        setOutcome('proposed');
        await keep(
          tx,
          withItem(current.data, index, { outcome: 'proposed', fieldHash: decision.fieldHash }),
        );
        return false;
      },
      done: async (tx) => {
        const current = await this.locked(tx, row.id, gate);
        if (!current) return;
        const value = fieldValue(await this.state(tx, row.bookVersionId), target);
        const next = withItem(current.data, index, { outcome: 'written', fieldHash: null });
        next.written[target] = fieldPrint(value);
        await keep(tx, next);
        setOutcome('written');
      },
    });
  }

  /**
   * «Accept» предложения (`tech.md` §5): содержимое поля сверяется с отпечатком на момент
   * предложения - не совпало, 409 `SUMMARY_FIELD_CHANGED` с содержимым поля. Раздел - замена
   * раздела того же номера (нумерация не меняется; иной охват глав - только с
   * `confirmChapterChange`, иначе 409 `SUMMARY_CHAPTER_CHANGE`) или «в конец» ровно под номером
   * плана, когда перед ним уже N-1 разделов (решение арбитра, круг 1, В1).
   */
  async accept(
    row: Pick<ContentDraft, 'id' | 'bookVersionId'>,
    index: number,
    confirmChapterChange: boolean,
  ): Promise<void> {
    const gate = readyGate;
    const before = await this.read(row, gate);
    const item = before?.items[index];
    if (!item || item.outcome !== 'proposed' || item.fieldHash === null) {
      throw llmTaskConflict(SUMMARY_ITEM_NOT_PROPOSED, 'The text is not a proposal');
    }
    // Под замком: то же предложение и перегенерация его не идёт (L-019).
    const proposed = (current: SummaryWriteData | undefined): SummaryWriteData => {
      const it = current?.items[index];
      if (!current || !it || it.outcome !== 'proposed' || it.fieldHash !== item.fieldHash) {
        throw llmTaskConflict(SUMMARY_ITEM_NOT_PROPOSED, 'The text is not a proposal');
      }
      if (it.regen) {
        throw llmTaskConflict(SUMMARY_REGEN_IN_PROGRESS, 'This text is being regenerated');
      }
      return current;
    };
    const accepted = async (tx: Db) => {
      const current = await this.locked(tx, row.id, gate);
      if (!current) throw llmTaskConflict(SUMMARY_ITEM_NOT_PROPOSED, 'The text is not a proposal');
      await this.save(tx, row.id, withItem(current.data, index, { outcome: 'accepted' }));
    };
    if (item.target === 'section') {
      const written = await this.sections.writeGuarded(row.bookVersionId, sectionContent(item), {
        decide: async (tx) => {
          const data = proposed((await this.locked(tx, row.id, gate))?.data);
          const state = await this.state(tx, row.bookVersionId, true);
          const number = item.number as number;
          const own = state.sections.find((s) => s.number === number);
          if (item.fieldMode === 'replace') {
            if (!own || sectionPrint(own) !== item.fieldHash) throw fieldChanged(own ?? null);
            if (chapterChanged(item, state, number) && !confirmChapterChange) {
              throw chapterChange(item, state, number);
            }
            return { kind: 'replace', number };
          }
          return appendAllowed(data, item, state) ? { kind: 'append' } : throwAppend(item, state);
        },
        done: (tx) => accepted(tx),
      });
      if (!written) throw fieldChanged(null);
      return;
    }
    const target = item.target;
    const written = await this.summaries.writeGuarded(
      row.bookVersionId,
      target,
      summaryHtml(item.text),
      {
        allow: async (tx) => {
          proposed((await this.locked(tx, row.id, gate))?.data);
          const state = await this.state(tx, row.bookVersionId, true);
          const value = fieldValue(state, target);
          if (fieldPrint(value) !== item.fieldHash) throw fieldChanged({ text: value });
          // «Очень кратко» без полного с текстом не пишется (`upsertBrief`) - своя причина, а не
          // «поле изменили»: принять сначала полный.
          if (target === 'brief' && !state.hasText) {
            throw llmTaskConflict(SUMMARY_FULL_UNFINISHED, 'Accept or save the full summary first');
          }
          return true;
        },
        done: (tx) => accepted(tx),
      },
    );
    // «Очень кратко» без полного с текстом: поле пустым полным не заводится (`upsertBrief`).
    if (!written) throw fieldChanged(null);
  }

  /**
   * Иное деление у разделов-предложений замены (`tech.md` §5, В3): «Accept all» на такой версии -
   * 409 `ACCEPT_ALL_CHAPTER_CHANGE` до первой записи. Одна функция с `accept` - `chapterChanged`.
   */
  async chapterChanges(
    row: Pick<ContentDraft, 'bookVersionId'>,
    data: SummaryWriteData,
  ): Promise<number[]> {
    const state = await this.state(this.prisma, row.bookVersionId);
    return data.items.flatMap((item) =>
      item.target === 'section' &&
      item.outcome === 'proposed' &&
      item.fieldMode === 'replace' &&
      chapterChanged(item, state, item.number as number)
        ? [item.number as number]
        : [],
    );
  }

  private async locked(
    tx: Db,
    id: string,
    gate: DraftGate,
  ): Promise<{ row: ContentDraft; data: SummaryWriteData } | null> {
    const row = await tx.contentDraft.findUnique({ where: { id } });
    if (!row || row.kind !== 'summary_write') return null;
    const data = readWriteData(row.data);
    return gate.allows(row, data) ? { row, data } : null;
  }

  private async save(tx: Db, id: string, data: SummaryWriteData): Promise<void> {
    await tx.contentDraft.update({ where: { id }, data: { data: toJson(data) } });
  }
}

/**
 * «В конец» (В1): в версии ровно N-1 разделов; каждый из них - тот же, что был при предложении,
 * или текст этого же хода, записанный или принятый (раздел, принятый заменой, тоже).
 */
function appendAllowed(data: SummaryWriteData, item: WriteItem, state: FieldState): boolean {
  const number = item.number as number;
  const base = item.fieldBase ?? [];
  if (state.sections.length !== number - 1) return false;
  return state.sections.every((s, i) => {
    const print = sectionPrint(s);
    if (i < base.length && base[i] === print) return true;
    if (data.written.sections[String(s.number)] === print) return true;
    const own = data.items.find((x) => x.target === 'section' && x.number === s.number);
    return own?.outcome === 'accepted' && sectionPrint(sectionContent(own)) === print;
  });
}

function throwAppend(item: WriteItem, state: FieldState): never {
  const number = item.number as number;
  if (state.sections.length < number - 1) {
    throw new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      code: SUMMARY_FIELD_CHANGED,
      message: `Accept section ${state.sections.length + 1} first: section ${number} goes right after section ${number - 1}`,
      expectedNumber: state.sections.length + 1,
      current: null,
    });
  }
  throw fieldChanged(null);
}

function fieldChanged(
  current: { title?: string; text: string | null; readerChapter?: number | null } | null,
) {
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: SUMMARY_FIELD_CHANGED,
    message: 'The field was changed after the proposal: reload it',
    current,
  });
}

/**
 * Подтверждение смены деления (`product.md` §4, В3): охват раздела сейчас и после принятия и
 * разделы версии, чей охват пересекается с главами плана.
 */
function chapterChange(item: WriteItem, state: FieldState, number: number) {
  const was = sectionCoverage(state, number);
  const will = planCoverage(item.chapters);
  const sameChapterSections = state.sections
    .filter((s) => s.number !== number)
    .filter((s) => {
      const c = sectionCoverage(state, s.number);
      return c !== null && will !== null && c.from <= will.to && will.from <= c.to;
    })
    .map((s) => s.number);
  return new ConflictException({
    statusCode: 409,
    error: 'Conflict',
    code: SUMMARY_CHAPTER_CHANGE,
    message: `Section ${number} now covers ${range(was)}, will cover ${range(will)}: confirm with confirmChapterChange`,
    number,
    covers: was,
    willCover: will,
    sameChapterSections,
  });
}
