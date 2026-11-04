import { Prisma } from '@prisma/client';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { callIndependent, IndependentOutcome } from '../check/independent-call';
import { Shape } from '../dossier/dossier.format';
import { ShapedRequest } from '../dossier/dossier.prompts';
import { callShaped } from '../llm-shaped-call';
import { StageModels } from '../run/run-models';
import { DraftRemark, DraftRemarkCode } from './text-checks';

/**
 * Цикл качества чистовика, общий для пересказа (`F06`) и анализа (`F07`):
 * `features/F06-summary-autofill/product.md` §3, `batches.md` `F06-1` шаг 4.
 * Автор пишет → код → проверяющая другого семейства → есть замечания - ровно одна переделка
 * с их списком → снова код и проверяющая → итог. Замечания после переделки - флаги (U5), текст
 * не пропадает. Проверяющая выбирается по семейству **фактически ответившей** модели-автора.
 */

/**
 * Коды, которые ставит проверяющая модель пересказа (§3): длину, строй, язык, цитаты и мусор ставит
 * код. Умолчание `QualityLoopSpec.reviewCodes`: у анализа `F07` свой набор (решение арбитра
 * `F07 | F07-1`, В2).
 */
export const REVIEW_REMARK_CODES = [
  'NAME_MISMATCH',
  'FACT_UNSUPPORTED',
  'EVENT_MISSING',
  'EXTERNAL_FACT',
  'ORDER_BROKEN',
  'STYLE_POOR',
] as const satisfies readonly DraftRemarkCode[];

const str = 'string' as const;

/**
 * Ответ проверяющей: `{ verdict: 'ok' | 'remarks', remarks: [{ code, where, note }] }` (`tech.md` §3);
 * `code` - только из `codes`: код не из своего набора отбивается формой, а не доходит до флагов.
 */
export function reviewShapeOf(codes: readonly DraftRemarkCode[]): Shape {
  return {
    object: {
      verdict: { enum: ['ok', 'remarks'] },
      remarks: {
        array: { object: { code: { enum: [...codes] }, where: str, note: str } },
      },
    },
  };
}

/** Форма ответа проверяющей пересказа. */
export const REVIEW_SHAPE: Shape = reviewShapeOf(REVIEW_REMARK_CODES);

interface ReviewAnswer {
  verdict: 'ok' | 'remarks';
  remarks: Array<{ code: DraftRemarkCode; where: string; note: string }>;
}

/** Замечания проверяющей; вердикт `ok` при непустом списке - замечания всё равно в счёт. */
function reviewRemarks(value: unknown): DraftRemark[] {
  const answer = value as ReviewAnswer;
  return answer.remarks.map((r) => ({ code: r.code, where: r.where, note: r.note, by: 'model' }));
}

/** Переделка: прошлый текст автора и замечания к нему. */
export interface Redo<T> {
  previous: T;
  remarks: DraftRemark[];
}

export interface QualityLoopSpec<T> {
  authorStage: string;
  authorShape: Shape;
  /** Модели автора - снимок на старте хода (`tech.md` §3). */
  authorModels: StageModels;
  /** Запрос автору: первый раз `redo = null`, на переделке - прошлый текст и замечания. */
  authorRequest: (redo: Redo<T> | null) => ShapedRequest;
  /** Ответ автора по форме → текст части. */
  readAuthor: (value: unknown) => T;
  /** Код-проверки части. */
  codeCheck: (draft: T) => DraftRemark[];
  reviewStage: string;
  /**
   * Коды проверяющей: из них строится форма её ответа (`reviewShapeOf`). Нет - коды пересказа
   * (`REVIEW_REMARK_CODES`); запрос `reviewRequest` строится той же формой.
   */
  reviewCodes?: readonly DraftRemarkCode[];
  reviewModels: StageModels;
  reviewRequest: (draft: T) => ShapedRequest;
  /**
   * Оплаченный текст автора сразу после ответа, до проверяющей (каждый круг): вызов проверяющей
   * может оборваться отказом модуля LLM (пауза бюджета) - без сохранения текст пропал бы вместе
   * с исключением и после «Continue» оплачивался бы заново.
   */
  onAuthored?: (authored: Authored<T>) => Promise<void>;
  /**
   * Итог первого круга перед переделкой: вызывающий сохраняет текст с замечаниями - переделка
   * может оборваться так же.
   */
  onBeforeRedo?: (first: QualityLoopDraft<T>) => Promise<void>;
  /**
   * Продолжение после обрыва (решение арбитра `F06 | F06-2`, Р3): текст, сохранённый `onAuthored`
   * или `onBeforeRedo`, второй раз не оплачивается. `attempt: 2` - переделка уже оплачена: только
   * код и проверяющая, второй переделки нет. `attempt: 1` с `checked` (сохранён `onBeforeRedo`) -
   * сразу переделка без повторной проверки первого текста; без `checked` - код и проверяющая
   * первого текста, дальше как обычно. Цена - только новых вызовов.
   */
  resume?: QualityLoopResume<T>;
}

/** Сохранённый текст круга, с которого цикл продолжает (`QualityLoopSpec.resume`). */
export interface QualityLoopResume<T> {
  draft: T;
  attempt: 1 | 2;
  authorModel: string;
  /** Итог проверки первого текста - есть, если сохранён перед переделкой (`onBeforeRedo`). */
  checked?: { remarks: DraftRemark[]; review: ReviewState };
}

/** Текст автора круга до проверяющей. */
export interface Authored<T> {
  draft: T;
  attempt: 1 | 2;
  authorModel: string;
  costUsd: Prisma.Decimal;
}

/** Как прошла проверяющая на последнем круге: `answered` - ответила, иначе - почему её не было. */
export type ReviewState =
  | { kind: 'answered'; model: string }
  | { kind: Exclude<IndependentOutcome<unknown>['kind'], 'answered'> };

export type QualityLoopResult<T> =
  | {
      ok: true;
      draft: T;
      /** 1 - без переделки или переделка не дала текста; 2 - итог переделки. */
      attempt: 1 | 2;
      verdict: 'ok' | 'flags';
      remarks: DraftRemark[];
      authorModel: string;
      review: ReviewState;
      costUsd: Prisma.Decimal;
    }
  | { ok: false; costUsd: Prisma.Decimal };

/** Итог цикла с текстом. */
export type QualityLoopDraft<T> = Extract<QualityLoopResult<T>, { ok: true }>;

/** Повторов с замечанием о форме у вызова автора (как досье и заготовки). */
const AUTHOR_FORM_REMARKS = 1;

interface Round<T> {
  draft: T;
  authorModel: string;
  remarks: DraftRemark[];
  review: ReviewState;
}

/**
 * Цикл одной части. Отказы модуля LLM, кроме ответа не по форме, уходят вызывающему (бюджет -
 * пауза, остальное решает обработчик), как у `callShaped`. Автор не дал текста по форме в первый
 * раз - `{ ok: false }`; на переделке - итог первого круга с его замечаниями. Цена - сумма всех
 * оплаченных ответов автора и проверяющей обоих кругов.
 */
export async function runQualityLoop<T>(
  llm: LlmService,
  operationId: string,
  ctx: LlmTaskContext,
  spec: QualityLoopSpec<T>,
): Promise<QualityLoopResult<T>> {
  let costUsd = new Prisma.Decimal(0);
  const reviewShape = spec.reviewCodes ? reviewShapeOf(spec.reviewCodes) : REVIEW_SHAPE;

  const round = async (redo: Redo<T> | null, attempt: 1 | 2): Promise<Round<T> | null> => {
    const answer = await callShaped(
      llm,
      operationId,
      spec.authorStage,
      spec.authorRequest(redo),
      spec.authorShape,
      ctx,
      { remarks: AUTHOR_FORM_REMARKS, ...spec.authorModels },
    );
    costUsd = costUsd.add(answer.costUsd);
    if (!answer.ok) return null;
    const draft = spec.readAuthor(answer.value);
    await spec.onAuthored?.({ draft, attempt, authorModel: answer.model, costUsd });
    return check(draft, answer.model);
  };

  const check = async (draft: T, authorModel: string): Promise<Round<T>> => {
    const code = spec.codeCheck(draft);
    const outcome = await callIndependent(
      llm,
      operationId,
      spec.reviewStage,
      spec.reviewRequest(draft),
      reviewShape,
      reviewRemarks,
      authorModel,
      spec.reviewModels,
      ctx,
    );
    if (outcome.kind === 'answered' || outcome.kind === 'invalid') {
      costUsd = costUsd.add(outcome.costUsd);
    }
    const review: ReviewState =
      outcome.kind === 'answered'
        ? { kind: 'answered', model: outcome.model }
        : { kind: outcome.kind };
    const model = outcome.kind === 'answered' ? outcome.answer : [];
    return { draft, authorModel, remarks: [...code, ...model], review };
  };

  const done = (r: Round<T>, attempt: 1 | 2): QualityLoopDraft<T> => ({
    ok: true,
    draft: r.draft,
    attempt,
    // Без ответа проверяющей текст не проверен моделью: «годен» не ставится (§3 - две проверки).
    verdict: r.remarks.length === 0 && r.review.kind === 'answered' ? 'ok' : 'flags',
    remarks: r.remarks,
    authorModel: r.authorModel,
    review: r.review,
    costUsd,
  });

  const resume = spec.resume;
  if (resume?.attempt === 2) return done(await check(resume.draft, resume.authorModel), 2);
  const first: Round<T> | null = !resume
    ? await round(null, 1)
    : resume.checked
      ? { draft: resume.draft, authorModel: resume.authorModel, ...resume.checked }
      : await check(resume.draft, resume.authorModel);
  if (first === null) return { ok: false, costUsd };
  if (first.remarks.length === 0) return done(first, 1);
  await spec.onBeforeRedo?.(done(first, 1));
  const second = await round({ previous: first.draft, remarks: first.remarks }, 2);
  return second === null ? done(first, 1) : done(second, 2);
}
