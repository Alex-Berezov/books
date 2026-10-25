import { Language, Prisma, TranslationChunkStatus } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ChapterLayout } from '../chapter-blocks';
import {
  CHECK_FAILURES_MAX,
  CHECK_FLAG_REASONS,
  CHECK_JEV_STAGE,
  CHECK_SEMANTIC_STAGE,
} from '../check/check.constants';
import {
  attemptSeed,
  cappedRemarks,
  CheckAttempt,
  ChunkVerdict,
  currentAttempt,
  emptyVerdict,
  verdictOf,
} from '../check/chunk-verdict';
import { jevFailure } from '../check/jev-check';
import { checkJev } from '../check/jev-step';
import {
  CheckFailure,
  checkMechanical,
  nameEntriesOf,
  pieceTexts,
} from '../check/mechanical-check';
import { semanticFailed, semanticFailures } from '../check/semantic-check';
import { checkSemantic, semanticInputOf } from '../check/semantic-step';
import { StageModels } from '../run/run-models';
import { CHUNK_INVALID_RESPONSE, CHUNK_TOO_LONG } from '../run/translation-run.constants';
import { TRANSLATE_STAGE } from './translate.constants';
import { TranslatedBlock } from './translate.format';
import {
  chunkBlocks,
  doneRunBefore,
  glossaryFor,
  lastTranslated,
  pieceInput,
  tailOf,
} from './translate-piece';
import { PieceTranslation, translatePiece } from './translate-step';

/**
 * Кусок на входе шагов перевода и проверок: строка куска запуска или попытка его повтора
 * (`F05-7v`) - те же поля, разное место записи (`ChunkStore`).
 */
export interface StepChunk {
  id: string;
  chunkIndex: number;
  firstBlock: number;
  lastBlock: number;
  words: number;
  status: TranslationChunkStatus;
  blocks: Prisma.JsonValue;
  verdict: Prisma.JsonValue;
  model: string | null;
  costUsd: Prisma.Decimal | null;
}

/** Поля куска на входе шагов - одна выборка у шага запуска и у повтора. */
export const CHUNK_STEP_SELECT = {
  id: true,
  chunkIndex: true,
  firstBlock: true,
  lastBlock: true,
  words: true,
  status: true,
  blocks: true,
  verdict: true,
  model: true,
  costUsd: true,
} as const;

/**
 * Досье запуска и глоссарий языка - данные перевода и проверок куска; одно чтение у шага запуска
 * и у повтора, чтобы повтор переводил с тем же контекстом, что соседние куски.
 */
export async function chunkStepContext(
  prisma: Pick<PrismaService, 'bookDossier' | 'bookGlossary'>,
  dossierId: string | null,
  glossaryId: string | null,
): Promise<{ dossier: unknown; glossary: unknown }> {
  const [dossier, glossary] = await Promise.all([
    prisma.bookDossier.findUnique({ where: { id: dossierId ?? '' }, select: { data: true } }),
    prisma.bookGlossary.findUnique({ where: { id: glossaryId ?? '' }, select: { data: true } }),
  ]);
  return { dossier: dossier?.data ?? null, glossary: glossary?.data ?? null };
}

/** Запись шага в кусок: `costUsd` - прибавка к стоимости куска, `attempt` - +1 к попыткам перевода. */
export interface ChunkWrite {
  status?: TranslationChunkStatus;
  rawResponse?: unknown;
  blocks?: TranslatedBlock[];
  model?: string;
  callId?: string;
  costUsd?: Prisma.Decimal | null;
  attempt?: boolean;
  verdict?: ChunkVerdict;
}

/**
 * Куда пишут шаги. Каждая запись - условием «кусок всё ещё в статусе `from`»: повтор шага после
 * потерянной аренды второй раз не пишет и не платит (`tech.md` §5). Флаг - со счётчиком флагов
 * языка у строки запуска; у попытки повтора счётчик меняет подмена куска, а не флаг попытки.
 */
export interface ChunkStore {
  write(from: TranslationChunkStatus, write: ChunkWrite): Promise<void>;
  flag(from: 'pending' | 'translated', reason: string, write: ChunkWrite): Promise<void>;
}

/** Всё, что шагам нужно кроме куска: операция, которая платит, контекст и модели этапов. */
export interface ChunkStepInput {
  llm: LlmService;
  /** Операция оплаты: запуска у шага запуска, своя у повтора куска. */
  operationId: string;
  ctx: LlmTaskContext;
  sourceLanguage: Language;
  targetLanguage: Language;
  chapterNumber: number;
  layout: ChapterLayout;
  /** Куски главы по порядку: границы кусков и хвост предыдущего переведённого. */
  chunks: readonly StepChunk[];
  dossier: unknown;
  glossary: unknown;
  models: (stage: string) => StageModels;
}

/** `no_provider` - все модели этапа отказали по политике данных (Р7): паузу ставит вызывающий. */
export type ChunkStepResult =
  | { kind: 'continue' }
  | { kind: 'no_provider'; stage: string; models: StageModels };

const CONTINUE: ChunkStepResult = { kind: 'continue' };

/** Перевод куска (`F05-4`, шаг 5): ответ модели - в кусок до записи итога шага. */
export async function translateChunk(
  input: ChunkStepInput,
  chunk: StepChunk,
  store: ChunkStore,
): Promise<ChunkStepResult> {
  const verdict = verdictOf(chunk.verdict);
  const previous = lastTranslated(
    doneRunBefore(
      input.chunks.map((c) => ({
        chunkIndex: c.chunkIndex,
        done: c.status === 'done',
        blocks: (c.blocks ?? []) as unknown as TranslatedBlock[],
      })),
      chunk.chunkIndex,
    ),
  );
  const piece = pieceInput({
    layout: input.layout,
    chunks: input.chunks.map((c) => ({
      firstBlock: c.firstBlock,
      lastBlock: c.lastBlock,
      words: c.words,
    })),
    index: chunk.chunkIndex,
    dossier: input.dossier,
    glossary: input.glossary,
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    chapterNumber: input.chapterNumber,
    previousTail: previous ? tailOf(previous) : null,
  });
  // Перевод заново после провала проверки - с замечаниями проверяющего (решение арбитра
  // `F05 | F05-5`); сид и счётчик неудач остаются в вердикте.
  if (verdict && verdict.remarks.length > 0) piece.reviewerRemarks = verdict.remarks;
  const models = input.models(TRANSLATE_STAGE);
  let result: PieceTranslation;
  try {
    result = await translatePiece(
      input.llm,
      input.operationId,
      piece,
      input.layout,
      input.ctx,
      models,
    );
  } catch (error) {
    if (error instanceof LlmError && error.code === 'LLM_NO_COMPLIANT_PROVIDER') {
      return { kind: 'no_provider', stage: TRANSLATE_STAGE, models };
    }
    throw error;
  }
  await input.ctx.renewLease();
  switch (result.kind) {
    // Кусок без переводимых блоков (только `hr` и картинки без подписей): модель не звалась.
    case 'empty':
      await store.write('pending', { status: 'done', blocks: [] });
      return CONTINUE;
    case 'too_long':
      await store.flag('pending', CHUNK_TOO_LONG, {});
      return CONTINUE;
    case 'invalid':
      // Перевод заново после провала проверки - попытка в вердикт: его стоимость сходится с куском.
      // Ответ не по форме - модель неизвестна (`translatedBy` пустой), есть только стоимость.
      verdict?.attempts.push({
        translatedBy: '',
        translateCostUsd: result.costUsd.toString(),
        outcome: 'invalid',
      });
      await store.flag('pending', CHUNK_INVALID_RESPONSE, {
        costUsd: result.costUsd,
        attempt: true,
        ...(verdict ? { verdict } : {}),
      });
      return CONTINUE;
    case 'translated': {
      // Попытка - новая строка вердикта: проверки пишут в неё, сумма куска растёт (В7).
      const next = verdict ?? emptyVerdict(chunk.id);
      next.attempts.push({
        translatedBy: result.model,
        translateCostUsd: result.costUsd.toString(),
      });
      await store.write('pending', {
        status: 'translated',
        attempt: true,
        rawResponse: result.raw,
        blocks: result.blocks,
        model: result.model,
        callId: result.callId,
        costUsd: result.costUsd,
        verdict: next,
      });
      return CONTINUE;
    }
  }
}

/**
 * Проверки переведённого куска (`F05-5`; `tech.md` §6): механика кодом каждый шаг (она
 * дешёвая и детерминированная), Jev - отдельным шагом с записью ответа, сверка смысла - с записью
 * решения. Каждый платный ответ пишется в кусок вместе со своей стоимостью - повтор шага после
 * падения его не оплачивает. Провал → перевод заново с замечаниями, вторая неудача - флаг.
 */
export async function checkChunk(
  input: ChunkStepInput,
  chunk: StepChunk,
  store: ChunkStore,
): Promise<ChunkStepResult> {
  const { llm, operationId, ctx } = input;
  // Кусок, переведённый до `F05-5` (запуск шёл во время выката): попытка из полей куска.
  const verdict = verdictOf(chunk.verdict) ?? emptyVerdict(chunk.id);
  let attempt = currentAttempt(verdict);
  if (!attempt) {
    attempt = {
      translatedBy: chunk.model ?? '',
      translateCostUsd: (chunk.costUsd ?? new Prisma.Decimal(0)).toString(),
    };
    verdict.attempts.push(attempt);
  }
  const source = chunkBlocks(input.layout, chunk);
  const translated = (chunk.blocks ?? []) as unknown as TranslatedBlock[];
  const sourceText = pieceTexts(source).sourceText;
  const names = nameEntriesOf(glossaryFor(input.glossary, input.dossier, sourceText).entries);
  const mechanical = checkMechanical({
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    source,
    translated,
    glossary: names,
  });
  attempt.mechanical = mechanical;
  // Механика провалилась - платные проверки ответ не изменят: перевод заново без них.
  if (mechanical.failures.length > 0) {
    return failCheck(store, verdict, attempt, mechanical.failures);
  }

  if (attempt.jev === undefined) {
    const jev = await checkJev(
      llm,
      operationId,
      pieceTexts(source, translated).translatedText,
      input.models(CHECK_JEV_STAGE),
      ctx,
    );
    await ctx.renewLease();
    attempt.jev = jev;
    if (jev.kind !== 'disabled') {
      // Ответ Jev - в кусок до решения со своей стоимостью: повтор шага его не оплачивает.
      await store.write('translated', {
        verdict,
        ...(jev.costUsd ? { costUsd: new Prisma.Decimal(jev.costUsd) } : {}),
      });
      return CONTINUE;
    }
  }
  const jevFailed = jevFailure(attempt.jev, input.targetLanguage);
  if (jevFailed) return failCheck(store, verdict, attempt, [jevFailed]);

  const missed = names.filter((n) => mechanical.nameMisses.includes(n.key));
  const semanticInput = semanticInputOf({
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    source,
    translated,
    seed: attemptSeed(verdict),
    names: missed,
  });
  const models = input.models(CHECK_SEMANTIC_STAGE);
  const outcome = await checkSemantic(
    llm,
    operationId,
    semanticInput,
    attempt.translatedBy,
    models,
    ctx,
  );
  switch (outcome.kind) {
    case 'not_independent':
      attempt.outcome = 'not_independent';
      await store.flag('translated', CHECK_FLAG_REASONS.NOT_INDEPENDENT, { verdict });
      return CONTINUE;
    case 'unavailable':
      // Этап выключили или модель потеряла цену посреди запуска (решение арбитра
      // `F05 | F05-5`): перевод заново не поможет - флаг, язык идёт дальше.
      attempt.outcome = 'unavailable';
      await store.flag('translated', CHECK_FLAG_REASONS.CHECK_STAGE_UNAVAILABLE, { verdict });
      return CONTINUE;
    case 'no_provider':
      return { kind: 'no_provider', stage: CHECK_SEMANTIC_STAGE, models: outcome.models };
    case 'too_long':
      // Исходник с переводом не влезает в контекст проверяющего: сверить нечем - флаг, как
      // `CHUNK_TOO_LONG` у перевода, а не отказ шага по кругу.
      attempt.outcome = 'too_long';
      await store.flag('translated', CHECK_FLAG_REASONS.CHECK_INPUT_TOO_LONG, { verdict });
      return CONTINUE;
    case 'invalid':
      await ctx.renewLease();
      attempt.semantic = { model: '', costUsd: outcome.costUsd.toString(), answer: null };
      attempt.outcome = 'invalid';
      await store.flag('translated', CHECK_FLAG_REASONS.CHUNK_CHECK_INVALID_RESPONSE, {
        costUsd: outcome.costUsd,
        verdict,
      });
      return CONTINUE;
    case 'answered':
      break;
  }
  await ctx.renewLease();
  attempt.semantic = {
    model: outcome.model,
    costUsd: outcome.costUsd.toString(),
    answer: outcome.answer,
  };
  if (semanticFailed(outcome.answer, missed)) {
    return failCheck(
      store,
      verdict,
      attempt,
      semanticFailures(outcome.answer, missed),
      outcome.costUsd,
    );
  }
  attempt.outcome = 'pass';
  await store.write('translated', { status: 'checked', verdict, costUsd: outcome.costUsd });
  return CONTINUE;
}

/**
 * Неудача проверки: замечания - в вердикт, кусок - в перевод заново (`pending`); неудача
 * `CHECK_FAILURES_MAX` - флаг с кодом первой причины, язык идёт дальше. Находки глоссария
 * у флага не применяются (решение арбитра `F05 | F05-5`).
 */
async function failCheck(
  store: ChunkStore,
  verdict: ChunkVerdict,
  attempt: CheckAttempt,
  failures: readonly CheckFailure[],
  costUsd: Prisma.Decimal | null = null,
): Promise<ChunkStepResult> {
  attempt.outcome = 'fail';
  verdict.failures += 1;
  verdict.remarks = cappedRemarks(failures.map((f) => f.remark));
  if (verdict.failures >= CHECK_FAILURES_MAX) {
    await store.flag('translated', failures[0].code, { costUsd, verdict });
    return CONTINUE;
  }
  await store.write('translated', { status: 'pending', verdict, costUsd });
  return CONTINUE;
}

/**
 * Прибавка к стоимости куска (решение арбитра `F05 | F05-5`: сумма всех платных ответов
 * куска, В7). Пустая колонка - первая стоимость: `increment` по `NULL` дал бы `NULL`.
 */
export function costAdded(
  current: Prisma.Decimal | null,
  add: Prisma.Decimal | string,
): Prisma.Decimal | { increment: Prisma.Decimal | string } {
  return current === null ? new Prisma.Decimal(add) : { increment: add };
}
