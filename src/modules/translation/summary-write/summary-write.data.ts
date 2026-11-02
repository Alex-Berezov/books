import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';
import { isRecord } from '../../../shared/prisma/json-record.util';
import { QualityLoopResume, ReviewState } from '../draft-quality/quality-loop';
import { DRAFT_REMARK_CODES, DraftRemark, DraftRemarkCode } from '../draft-quality/text-checks';
import { DRAFT_DATA_INVALID } from '../content-draft/content-draft.constants';
import { SummaryTarget } from './summary-checks';

/**
 * Данные хода пересказа в `ContentDraft.data` (`features/F06-summary-autofill/tech.md` §2, §5;
 * решения арбитра `F06 | F06-2`, Р1, Р2, Р8). Форма проверяется на чтении: элемент не той формы
 * остаётся на своём месте заглушкой «не удалось» (`brokenItem`) и пишется назад как был.
 */

/**
 * Судьба текста хода: `waiting` - раздел готов, но раздел плана перед ним текста не получил, и
 * прямой записи он ждёт по порядку (Р1); `written` - записан в поле; `proposed` - предложение
 * редактору; `accepted`/`discarded` - решение редактора; `none` - текста нет (`verdict: 'failed'`).
 */
export const ITEM_OUTCOMES = [
  'waiting',
  'written',
  'proposed',
  'accepted',
  'discarded',
  'none',
] as const;
export type ItemOutcome = (typeof ITEM_OUTCOMES)[number];

export const ITEM_VERDICTS = ['ok', 'flags', 'failed'] as const;

export const ITEM_TARGETS = [
  'section',
  'full',
  'brief',
] as const satisfies readonly SummaryTarget[];
export type ItemVerdict = (typeof ITEM_VERDICTS)[number];

export const REVIEW_KINDS = [
  'answered',
  'not_independent',
  'too_long',
  'invalid',
  'no_provider',
  'unavailable',
] as const;

/** Перегенерация, которая идёт: своя операция и замечание редактора (Р2, Р8). */
export interface ItemRegen {
  operationId: string;
  remark: string | null;
  /** Оплаченный текст круга перегенерации до итога (Р3). */
  pending: PendingText | null;
  /** Текст перегенерации записан: дальше - достройка полного и «Очень кратко» (`tech.md` §4). */
  produced: boolean;
  /**
   * Достраивать ли полный и «Очень кратко»: у раздела до перегенерации текста не было (`tech.md`
   * §4, его оценка закладывает их только тогда).
   */
  tail: boolean;
  /** Части, которые достройка уже пробовала: не удалась - не повторяется (ход кончается). */
  tailDone: Array<'full' | 'brief'>;
}

/** Текст круга, сохранённый до проверяющей или до переделки (Р3): ключ - часть и операция. */
export interface PendingText {
  key: string;
  operationId: string;
  resume: QualityLoopResume<string>;
}

export interface WriteItem {
  target: SummaryTarget;
  /** Номер раздела плана (только `section`). */
  number: number | null;
  title: string | null;
  readerChapter: number | null;
  /** Текст модели абзацами; HTML поля строит `summaryHtml`. */
  text: string;
  attempt: 1 | 2;
  verdict: ItemVerdict;
  remarks: DraftRemark[];
  review: ReviewState | null;
  outcome: ItemOutcome;
  failedReason: string | null;
  authorModel: string | null;
  /** Главы плана раздела, по возрастанию (только `section`): охват предложения (решение арбитра, круг 1, В3). */
  chapters: number[] | null;
  /** Отпечаток поля на момент предложения: «Accept» сверяет содержимое, а не `updatedAt` (§5). */
  fieldHash: string | null;
  /**
   * Что предлагает раздел: замену раздела того же номера или раздел «в конец». У «в конец»
   * `fieldBase` - отпечатки разделов версии, бывших при предложении, по номеру (В1).
   */
  fieldMode: 'replace' | 'append' | null;
  fieldBase: string[] | null;
  /** Последняя перегенерация не дала текста: прежний текст остаётся, причина - здесь. */
  regenFailedReason: string | null;
  regen: ItemRegen | null;
  /**
   * Элемент не той формы - сохранён как был: место в `items` не сдвигается (адрес ручек и задач -
   * индекс), запись данных возвращает его неизменным (решение арбитра, круг 3).
   */
  broken?: unknown;
}

/** Право хода на поле - на старте под замком (§5). */
export interface FieldOwnership {
  sections: boolean;
  full: boolean;
  brief: boolean;
}

/** Отпечаток последней записи хода в поле: поле менял только этот ход - совпадает (§5). */
export interface WrittenPrint {
  full: string | null;
  brief: string | null;
  /** Номер раздела → отпечаток записанного ходом раздела. */
  sections: Record<string, string>;
}

export interface SummaryWriteData {
  items: WriteItem[];
  owns: FieldOwnership;
  written: WrittenPrint;
  /** Разделов в плане досье; `null` - досье ещё нет. */
  plannedSections: number | null;
  /** Оплаченный текст хода до итога части (Р3). */
  pending: PendingText | null;
}

export const emptyWriteData = (owns: FieldOwnership, written: WrittenPrint): SummaryWriteData => ({
  items: [],
  owns,
  written,
  plannedSections: null,
  pending: null,
});

/** Отпечаток содержимого поля: sha256 строк через разделитель, которого нет в тексте. */
export function fieldPrint(...parts: Array<string | number | null>): string {
  return createHash('sha256')
    .update(parts.map((p) => (p === null ? '\u0000null' : String(p))).join('\u0001'))
    .digest('hex');
}

export const sectionPrint = (s: { title: string; text: string; readerChapter: number | null }) =>
  fieldPrint(s.title, s.text, s.readerChapter);

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const int = (v: unknown): number | null => (Number.isInteger(v) ? (v as number) : null);
const oneOf = <T extends string>(list: readonly T[], v: unknown): T | null =>
  typeof v === 'string' && (list as readonly string[]).includes(v) ? (v as T) : null;

function remarkOf(v: unknown): DraftRemark[] {
  if (!isRecord(v)) return [];
  const code = oneOf<DraftRemarkCode>(DRAFT_REMARK_CODES, v.code);
  const by = oneOf(['code', 'model'] as const, v.by);
  const where = str(v.where);
  const note = str(v.note);
  return code && by && where !== null && note !== null ? [{ code, where, note, by }] : [];
}

const remarksOf = (v: unknown): DraftRemark[] => (Array.isArray(v) ? v.flatMap(remarkOf) : []);

function reviewOf(v: unknown): ReviewState | null {
  if (!isRecord(v)) return null;
  const kind = oneOf(REVIEW_KINDS, v.kind);
  if (kind === 'answered') {
    const model = str(v.model);
    return model === null ? null : { kind, model };
  }
  return kind === null ? null : { kind };
}

function pendingOf(v: unknown): PendingText | null {
  if (!isRecord(v) || !isRecord(v.resume)) return null;
  const key = str(v.key);
  const operationId = str(v.operationId);
  const draft = str(v.resume.draft);
  const authorModel = str(v.resume.authorModel);
  const attempt = v.resume.attempt === 1 || v.resume.attempt === 2 ? v.resume.attempt : null;
  if (key === null || operationId === null || draft === null || !authorModel || !attempt) {
    return null;
  }
  const checked = isRecord(v.resume.checked) ? v.resume.checked : null;
  const review = checked ? reviewOf(checked.review) : null;
  return {
    key,
    operationId,
    resume: {
      draft,
      attempt,
      authorModel,
      ...(checked && review ? { checked: { remarks: remarksOf(checked.remarks), review } } : {}),
    },
  };
}

function regenOf(v: unknown): ItemRegen | null {
  if (!isRecord(v)) return null;
  const operationId = str(v.operationId);
  return operationId === null
    ? null
    : {
        operationId,
        remark: str(v.remark),
        pending: pendingOf(v.pending),
        produced: v.produced === true,
        tail: v.tail === true,
        tailDone: Array.isArray(v.tailDone)
          ? v.tailDone.filter((t): t is 'full' | 'brief' => t === 'full' || t === 'brief')
          : [],
      };
}

/**
 * Заглушка на месте элемента не той формы: «не удалось» без текста, та же часть (раздел остаётся
 * разделом, место в плане не сдвигается), сам элемент - в `broken`.
 */
function brokenItem(v: unknown): WriteItem {
  const r = isRecord(v) ? v : {};
  const target = oneOf(ITEM_TARGETS, r.target) ?? 'full';
  return {
    target,
    number: target === 'section' ? (int(r.number) ?? 0) : null,
    title: null,
    readerChapter: null,
    text: '',
    attempt: 1,
    verdict: 'failed',
    remarks: [],
    review: null,
    outcome: 'none',
    failedReason: DRAFT_DATA_INVALID,
    authorModel: null,
    chapters: null,
    fieldHash: null,
    fieldMode: null,
    fieldBase: null,
    regenFailedReason: null,
    regen: null,
    broken: v ?? null,
  };
}

function itemOf(v: unknown): WriteItem {
  if (!isRecord(v)) return brokenItem(v);
  const target = oneOf(ITEM_TARGETS, v.target);
  const verdict = oneOf(ITEM_VERDICTS, v.verdict);
  const outcome = oneOf(ITEM_OUTCOMES, v.outcome);
  const text = str(v.text);
  if (!target || !verdict || !outcome || text === null) return brokenItem(v);
  const number = int(v.number);
  if (target === 'section' && number === null) return brokenItem(v);
  return {
    target,
    number: target === 'section' ? number : null,
    title: str(v.title),
    readerChapter: int(v.readerChapter),
    text,
    attempt: v.attempt === 2 ? 2 : 1,
    verdict,
    remarks: remarksOf(v.remarks),
    review: reviewOf(v.review),
    outcome,
    failedReason: str(v.failedReason),
    authorModel: str(v.authorModel),
    chapters:
      target === 'section' && Array.isArray(v.chapters)
        ? v.chapters.filter((c): c is number => Number.isInteger(c))
        : null,
    fieldHash: str(v.fieldHash),
    fieldMode: oneOf(['replace', 'append'] as const, v.fieldMode),
    fieldBase: Array.isArray(v.fieldBase)
      ? v.fieldBase.filter((b): b is string => typeof b === 'string')
      : null,
    regenFailedReason: str(v.regenFailedReason),
    regen: regenOf(v.regen),
  };
}

/** Данные хода из `ContentDraft.data`; не той формы - пустой ход без права на поля. */
export function readWriteData(data: unknown): SummaryWriteData {
  const d = isRecord(data) ? data : {};
  const owns = isRecord(d.owns) ? d.owns : {};
  const written = isRecord(d.written) ? d.written : {};
  const sections = isRecord(written.sections) ? written.sections : {};
  return {
    items: Array.isArray(d.items) ? d.items.map(itemOf) : [],
    owns: {
      sections: owns.sections === true,
      full: owns.full === true,
      brief: owns.brief === true,
    },
    written: {
      full: str(written.full),
      brief: str(written.brief),
      sections: Object.fromEntries(
        Object.entries(sections).filter((e): e is [string, string] => typeof e[1] === 'string'),
      ),
    },
    plannedSections: int(d.plannedSections),
    pending: pendingOf(d.pending),
  };
}

/** Данные хода в `ContentDraft.data`: элемент не той формы уходит назад как был прочитан. */
export const toJson = (data: SummaryWriteData): Prisma.InputJsonValue =>
  ({
    ...data,
    items: data.items.map((item) => ('broken' in item ? item.broken : item)),
  }) as unknown as Prisma.InputJsonValue;

/** Ключ части для сохранённого текста: раздел - по номеру плана. */
export const partKey = (target: SummaryTarget, number: number | null): string =>
  target === 'section' ? `section:${number}` : target;

/** Разделы хода по номеру плана. */
export const sectionItems = (data: SummaryWriteData): WriteItem[] =>
  data.items.filter((i) => i.target === 'section');

/** У текста есть, чем стать разделом для полного (`product.md` §3): не `failed`. */
export const hasText = (item: WriteItem): boolean => item.verdict !== 'failed';

/** Копия данных с правкой одного текста. */
export function withItem(
  data: SummaryWriteData,
  index: number,
  patch: Partial<WriteItem>,
): SummaryWriteData {
  return {
    ...data,
    written: { ...data.written, sections: { ...data.written.sections } },
    items: data.items.map((item, i) => (i === index ? { ...item, ...patch } : item)),
  };
}
