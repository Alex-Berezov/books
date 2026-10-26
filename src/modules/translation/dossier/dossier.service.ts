import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  BookDossier,
  BookGlossary,
  Language,
  LlmOperation,
  LlmPauseReason,
  Prisma,
  TranslationRunLanguageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmBudgetService } from '../../llm/llm-budget.service';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { EnqueueTaskInput, LlmTaskService } from '../../llm-worker/llm-task.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { FingerprintChapter, sourceFingerprint } from '../source-fingerprint';
import { TranslationSourceService } from '../translation-source.service';
import {
  DOSSIER_LIMIT_FACTOR,
  DOSSIER_MAX_CHAPTERS,
  DOSSIER_SOURCE_CHANGED,
  DOSSIER_STAGE,
  DOSSIER_TASK_KIND,
  DOSSIER_TOO_LONG,
  GLOSSARY_STAGE,
  GLOSSARY_TASK_KIND,
} from './dossier.constants';
import { DossierEstimateDto, DossierStatusDto, GlossaryDto } from '../dto/translation-response.dto';
import { DossierPartPlan, partKey, planDossierParts, planEntries } from './dossier-parts';
import { toDossierStatusDto, toEstimateDto, toGlossaryDto } from './dossier.mapper';
import { dossierPartRequest, dossierSummaryRequest, glossaryRequest } from './dossier.prompts';

/** Заводка строителя: операция, строка и первая задача - короткими INSERT (`L-020`). */
const BUILD_TX_OPTIONS = { timeout: 10_000, maxWait: 5_000 } as const;

/**
 * Кто ждёт досье или глоссарий: шаг чужой операции (запуск `F05-4`, сравнение, заготовка).
 * `waitingFor` - строка, которую он ждал прошлым шагом: её `failed` - отказ ждущего, а не
 * повод строить заново.
 */
export interface DossierWaiter {
  operationId: string;
  waitingFor?: string | null;
  /** Запуск ждущего (`F05-4`): операция, заведённая ради него, привязывается к нему. */
  translationRunId?: string | null;
  /**
   * Лимита ждущего не хватило на операцию досье или глоссария (Р20): запись ждущего с лимитом,
   * с которым она поместится, - той же транзакцией, что пауза его операции: опрос не видит паузу
   * без причины, а причину без паузы (решение арбитра `F05 | F05-7`, /fix В2).
   */
  onLimit?: (tx: Prisma.TransactionClient, minLimitUsd: Prisma.Decimal) => Promise<void>;
}

export interface DemandOptions {
  waiter?: DossierWaiter;
  limitUsd?: Prisma.Decimal;
  createdById?: string | null;
}

/**
 * Итог запроса досье или глоссария. `paused` и `failed` у ждущего уже записаны: его операция
 * на паузе `DOSSIER_PAUSED` (строитель на паузе, id операции досье - здесь), `LIMIT_REACHED`
 * (в остаток его лимита не помещается операция, которую он завёл бы: новое поколение досье,
 * новый или повторный глоссарий, перехват) или `STEP_FAILED` (строка не построилась) - Р20.
 */
export type Demand<Row> =
  | { status: 'ready'; row: Row }
  | { status: 'wait'; row: Row }
  | {
      status: 'paused';
      /** `null` - ждущему не хватило лимита на первое поколение, строки ещё нет. */
      row: Row | null;
      reason: 'DOSSIER_PAUSED' | 'LIMIT_REACHED';
      builderOperationId: string | null;
    }
  | { status: 'failed'; row: Row };

export interface DossierEstimate {
  sourceVersionId: string;
  chapters: number;
  parts: number;
  estimateUsd: Prisma.Decimal;
  suggestedLimitUsd: Prisma.Decimal;
}

/**
 * Что построится перед переводом и во что обойдётся (решение арбитра `F05 | F05-3`, С10): `null` -
 * строить не нужно (готово или уже строится). Глоссарий до готового досье - оценка сверху: вход
 * - досье размером в `maxTokens` этапа `dossier` (`upperBound`).
 */
export interface ContextEstimate {
  sourceVersionId: string;
  dossier: DossierEstimate | null;
  glossary: {
    estimateUsd: Prisma.Decimal;
    suggestedLimitUsd: Prisma.Decimal;
    upperBound: boolean;
  } | null;
}

/** Оценка контекста на несколько языков: досье одно, глоссарий на язык (`null` - строить не нужно). */
export interface ContextEstimates {
  sourceVersionId: string;
  dossier: DossierEstimate | null;
  glossaries: Map<Language, ContextEstimate['glossary']>;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

/** Причина, с которой строка досье закрыта без сводки, и модель, на которой это выяснилось. */
export interface DossierFailure {
  failedReason: string;
  model?: string;
}

/** Строку перехватил другой ждущий, пока шла заводка: транзакция откатывается. */
class TakeoverLostError extends Error {}

/**
 * Досье и глоссарий (`F05-2`, шаг 7, Р5, Р20). Строитель строки один: строка `building`
 * создаётся вставкой с уникальным ключом, проигравший ждёт. Построение - задачи исполнителя
 * под **своей** операцией вида `dossier` с лимитом оценка × 1,5, а не под операцией ждущего.
 *
 * Перехват - только у строителя в `failed` и один раз на строку; строитель на паузе - ждущий
 * встаёт на паузу `DOSSIER_PAUSED`; отменённый строитель или второй отказ - строка `failed`.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly budget: LlmBudgetService,
    private readonly tasks: LlmTaskService,
    private readonly sources: TranslationSourceService,
  ) {}

  /** Версия, чьё досье берёт открытая версия (Р5), и книга. */
  async dossierSourceOf(versionId: string): Promise<{ bookId: string; sourceVersionId: string }> {
    const { bookId, dossierSourceVersionId } = await this.sources.forVersion(versionId);
    return { bookId, sourceVersionId: dossierSourceVersionId };
  }

  /** Главы исходника; больше потолка - 409, а не досье по первым главам книги. */
  async chaptersOf(versionId: string): Promise<FingerprintChapter[]> {
    const chapters = await this.prisma.chapter.findMany({
      where: { bookVersionId: versionId },
      select: { number: true, title: true, content: true },
      orderBy: { number: 'asc' },
      take: DOSSIER_MAX_CHAPTERS + 1,
    });
    if (chapters.length > DOSSIER_MAX_CHAPTERS) {
      throw llmTaskConflict(
        'SOURCE_TOO_MANY_CHAPTERS',
        `The source has more than ${DOSSIER_MAX_CHAPTERS} chapters`,
      );
    }
    return chapters;
  }

  latestDossier(sourceVersionId: string): Promise<BookDossier | null> {
    return this.prisma.bookDossier.findFirst({
      where: { sourceVersionId },
      orderBy: { generation: 'desc' },
    });
  }

  /**
   * Состояние досье версии для админки: старшее поколение её исходника (Р5), свежесть по
   * отпечатку и операция строителя. Версия, созданная переводом, берёт досье своего запуска без
   * признака «устарел» (Р18, `F05-6`, 6b; решение арбитра `F05 | F05-4b`): правка исходника после
   * запуска досье перевода не меняет. Ручная версия и исходник - как прежде.
   */
  async status(versionId: string): Promise<DossierStatusDto> {
    const own = await this.runDossierOf(versionId);
    if (own) return this.statusOf(own.sourceVersionId, own.row, true);
    const { sourceVersionId } = await this.dossierSourceOf(versionId);
    const row = await this.latestDossier(sourceVersionId);
    const fresh = row
      ? sourceFingerprint(this.prisma, sourceVersionId).then((f) => row.fingerprint === f)
      : null;
    return this.statusOf(sourceVersionId, row, fresh);
  }

  async glossary(dossierId: string, language: Language): Promise<GlossaryDto> {
    const row = await this.prisma.bookGlossary.findUnique({
      where: { dossierId_language: { dossierId, language } },
    });
    if (!row) throw new NotFoundException('Glossary not found');
    const [operation, previousOperation] = await Promise.all([
      this.operationOf(row.operationId),
      this.operationOf(row.previousOperationId),
    ]);
    return toGlossaryDto(row, operation, previousOperation);
  }

  /**
   * Кнопка «построить досье»: свежее готовое - 409 `DOSSIER_FRESH`, устаревшее - новое
   * поколение, строится уже - состояние той же строки.
   */
  async build(
    versionId: string,
    limitUsd: Prisma.Decimal | undefined,
    createdById: string,
  ): Promise<DossierStatusDto> {
    // У версии перевода досье её запуска (Р18): строить досье исходника отсюда - платить за то,
    // чего эта версия не покажет (решение арбитра `F05 | F05-6`).
    if (await this.runDossierOf(versionId)) {
      throw llmTaskConflict(
        'DOSSIER_OF_RUN',
        'This version was made by a translation run: its dossier is the dossier of that run',
      );
    }
    this.llm.assertEnabled();
    const demand = await this.demandDossier(versionId, {
      rebuildStale: true,
      limitUsd,
      createdById,
    });
    if (demand.status === 'ready') {
      throw llmTaskConflict('DOSSIER_FRESH', 'A fresh dossier already exists for this source');
    }
    return this.status(versionId);
  }

  /** Оценка построения сверху: куски по `maxTokens` этапа плюс сводка по их ответам. */
  async estimate(versionId: string): Promise<DossierEstimateDto> {
    return toEstimateDto(await this.estimateOf(versionId));
  }

  /**
   * Досье и глоссарий, которые ещё предстоит построить, - строками оценки. `rebuildStale` - как
   * у `demandDossier`: готовое устаревшее досье ждущий строит новым поколением (запуск до
   * привязки досье), и оценка показывает его строкой (решение арбитра `F05 | F05-4b`).
   */
  async contextEstimate(
    versionId: string,
    language: Language,
    options: { rebuildStale?: boolean } = {},
  ): Promise<ContextEstimate> {
    const { sourceVersionId, dossier, glossaries } = await this.contextEstimates(
      versionId,
      [language],
      options,
    );
    return { sourceVersionId, dossier, glossary: glossaries.get(language) ?? null };
  }

  /** То же на несколько языков (запуск): досье считается один раз на книгу, глоссарий - на язык. */
  async contextEstimates(
    versionId: string,
    languages: readonly Language[],
    options: { rebuildStale?: boolean } = {},
  ): Promise<ContextEstimates> {
    const { sourceVersionId } = await this.dossierSourceOf(versionId);
    const found = await this.latestDossier(sourceVersionId);
    const latest =
      found?.status === 'ready' &&
      options.rebuildStale &&
      found.fingerprint !== (await sourceFingerprint(this.prisma, sourceVersionId))
        ? null
        : found;
    const glossaryLine = (estimateUsd: Prisma.Decimal, upperBound: boolean) => ({
      estimateUsd,
      suggestedLimitUsd: estimateUsd.mul(DOSSIER_LIMIT_FACTOR),
      upperBound,
    });
    const glossaries = new Map<Language, ContextEstimate['glossary']>();
    if (latest?.status === 'ready') {
      // Языков не больше пяти: строка глоссария на каждый.
      const rows = await this.prisma.bookGlossary.findMany({
        where: { dossierId: latest.id, language: { in: [...languages] } },
        select: { language: true, status: true },
      });
      for (const language of languages) {
        const row = rows.find((r) => r.language === language);
        glossaries.set(
          language,
          row?.status === 'ready' || row?.status === 'building'
            ? null
            : glossaryLine(await this.estimateGlossary(latest, language), false),
        );
      }
      return { sourceVersionId, dossier: null, glossaries };
    }
    const [dossier, call, dossierCall] = await Promise.all([
      latest?.status === 'building' ? null : this.estimateOf(versionId),
      this.estimator(GLOSSARY_STAGE),
      this.estimator(DOSSIER_STAGE),
    ]);
    for (const language of languages) {
      const upper = call.estimate(
        glossaryRequest({ dossier: null, language }),
        dossierCall.maxTokens * CHARS_PER_TOKEN,
      );
      glossaries.set(language, glossaryLine(upper, true));
    }
    return { sourceVersionId, dossier, glossaries };
  }

  private async estimateOf(versionId: string): Promise<DossierEstimate> {
    const { sourceVersionId } = await this.dossierSourceOf(versionId);
    const chapters = await this.chaptersOf(sourceVersionId);
    const plans = planDossierParts(chapters);
    if (plans.length === 0) throw this.noChapters();
    const estimateUsd = await this.estimatePlans(plans, chapters);
    return {
      sourceVersionId,
      chapters: new Set(plans.map((p) => p.chapterNumber)).size,
      parts: plans.length,
      estimateUsd,
      suggestedLimitUsd: estimateUsd.mul(DOSSIER_LIMIT_FACTOR),
    };
  }

  /**
   * Досье для версии (Р5). `rebuildStale` - кнопка «построить»: готовое устаревшее строится
   * новым поколением. Ждущему устаревшее отдаётся как есть - решение за ним (Р13).
   */
  async demandDossier(
    versionId: string,
    options: DemandOptions & { rebuildStale?: boolean } = {},
  ): Promise<Demand<BookDossier> & { fresh: boolean }> {
    const { bookId, sourceVersionId } = await this.dossierSourceOf(versionId);
    const fingerprint = await sourceFingerprint(this.prisma, sourceVersionId);
    const fresh = (row: BookDossier) => row.fingerprint === fingerprint;

    for (let round = 0; round < 3; round++) {
      const latest = await this.latestDossier(sourceVersionId);
      if (latest?.status === 'ready' && (fresh(latest) || !options.rebuildStale)) {
        return { status: 'ready', row: latest, fresh: fresh(latest) };
      }
      if (latest?.status === 'building') {
        const followed = await this.followDossierBuilder(latest, fresh(latest), options);
        // `null` - перехват ушёл другому ждущему; `failed` без ждущего (кнопка) - строка
        // закрыта, следующий круг строит новое поколение, а не отвечает «не построилось».
        if (followed && (followed.status !== 'failed' || options.waiter)) {
          return { ...followed, fresh: followed.row ? fresh(followed.row) : true };
        }
        continue;
      }
      if (
        latest?.status === 'failed' &&
        options.waiter &&
        // Строка ждущего упала на том же тексте - его отказ. Текст правили - строят новое
        // поколение по новому тексту, а не стоят на STEP_FAILED.
        ((options.waiter.waitingFor === latest.id && fresh(latest)) ||
          (await this.tooLongAgain(latest, fresh(latest))))
      ) {
        await this.pauseWaiter(options.waiter, 'STEP_FAILED');
        return { status: 'failed', row: latest, fresh: fresh(latest) };
      }
      // Нет строки, `failed` не нашего ожидания или устаревшее по кнопке - новое поколение.
      const started = await this.startDossier({
        bookId,
        sourceVersionId,
        generation: (latest?.generation ?? 0) + 1,
        fingerprint,
        options,
      });
      if (started === 'waiter-limit') {
        return {
          status: 'paused',
          row: latest,
          reason: 'LIMIT_REACHED',
          builderOperationId: null,
          fresh: latest ? fresh(latest) : true,
        };
      }
      if (started) return { status: 'wait', row: started, fresh: true };
      // P2002: строку того же поколения вставил другой - следующий круг пойдёт за ним.
    }
    throw llmTaskConflict('DOSSIER_BUSY', 'Dossier is being changed concurrently, try again');
  }

  /** Глоссарий пары (досье, язык): одна строка на пару, строитель один (Р20). */
  async demandGlossary(
    dossierId: string,
    language: Language,
    options: DemandOptions = {},
  ): Promise<Demand<BookGlossary>> {
    const dossier = await this.prisma.bookDossier.findUnique({ where: { id: dossierId } });
    if (!dossier) throw new NotFoundException('Dossier not found');
    if (dossier.status !== 'ready') {
      throw llmTaskConflict('DOSSIER_NOT_READY', 'Glossary needs a ready dossier');
    }
    for (let round = 0; round < 3; round++) {
      const row = await this.prisma.bookGlossary.findUnique({
        where: { dossierId_language: { dossierId, language } },
      });
      if (row?.status === 'ready') return { status: 'ready', row };
      if (row?.status === 'building') {
        const followed = await this.followGlossaryBuilder(row, dossier, options);
        if (followed && (followed.status !== 'failed' || options.waiter)) return followed;
        continue;
      }
      if (row?.status === 'failed' && options.waiter?.waitingFor === row.id) {
        await this.pauseWaiter(options.waiter, 'STEP_FAILED');
        return { status: 'failed', row };
      }
      const started = await this.startGlossary(dossier, language, row, options);
      if (started === 'waiter-limit') {
        return { status: 'paused', row, reason: 'LIMIT_REACHED', builderOperationId: null };
      }
      if (started) return { status: 'wait', row: started };
    }
    throw llmTaskConflict('GLOSSARY_BUSY', 'Glossary is being changed concurrently, try again');
  }

  // -------------------------------------------------------------------------
  // Досье
  // -------------------------------------------------------------------------

  private async startDossier(input: {
    bookId: string;
    sourceVersionId: string;
    generation: number;
    fingerprint: string;
    options: DemandOptions;
  }): Promise<BookDossier | 'waiter-limit' | null> {
    // Кнопка при исчерпанном потолке отказывает, а не заводит операцию на паузе (В11).
    // Ждущему из запуска - пауза по ходу, как по Р20.
    this.llm.assertEnabled();
    if (!input.options.waiter) await this.assertCeilingRoom();
    // Текст читается один раз на старте: план хранится в строке, шаг читает свою главу.
    const chapters = await this.chaptersOf(input.sourceVersionId);
    const plans = planDossierParts(chapters);
    if (plans.length === 0) throw this.noChapters();
    // Оценка нужна и при лимите редактора: модель без цены - 409 `LLM_NO_PRICE` до операции.
    const estimate = await this.estimatePlans(plans, chapters);
    const limitUsd = input.options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    if (!(await this.waiterFits(input.options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId: input.sourceVersionId,
      limitUsd,
      createdById: input.options.createdById ?? null,
      translationRunId: input.options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const row = await tx.bookDossier.create({
          data: {
            bookId: input.bookId,
            sourceVersionId: input.sourceVersionId,
            generation: input.generation,
            fingerprint: input.fingerprint,
            plan: planEntries(plans) as unknown as Prisma.InputJsonValue,
            operationId: op.id,
          },
        });
        await this.tasks.enqueue(this.dossierTask(row, op.id), tx);
        return row;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      // Строку того же поколения вставил другой: транзакция откатилась вместе с операцией.
      if (isUniqueViolation(error)) return null;
      throw error;
    }
  }

  /** `null` - перехват ушёл другому ждущему, строку надо перечитать. */
  private async followDossierBuilder(
    row: BookDossier,
    fresh: boolean,
    options: DemandOptions,
  ): Promise<Demand<BookDossier> | null> {
    const op = await this.operationOf(row.operationId);
    // Текст поменялся после старта: перехват достроил бы досье по старым кускам. Строка
    // закрывается, следующий, кому досье нужно, строит новое поколение.
    const verdict = await this.builderVerdict(row, op, options, 'bookDossier', fresh);
    if (verdict !== 'takeover') return verdict;
    const chapters = await this.chaptersOf(row.sourceVersionId);
    const all = planDossierParts(chapters);
    const done = await this.prisma.bookDossierPart.findMany({
      where: { dossierId: row.id },
      select: { chapterNumber: true, partIndex: true },
      take: all.length,
    });
    const saved = new Set(done.map((p) => partKey(p.chapterNumber, p.partIndex)));
    const remaining = all.filter((p) => !saved.has(partKey(p.chapterNumber, p.partIndex)));
    // Сводка оценивается по всем кускам: её вход - все частичные, и уже сохранённые тоже.
    const estimate = await this.estimatePlans(remaining, chapters, all);
    const taken = await this.takeOver(
      row,
      'bookDossier',
      estimate,
      options,
      row.sourceVersionId,
      (r, opId) => this.dossierTask(r, opId),
    );
    return this.takeoverDemand(row, taken);
  }

  private dossierTask(row: BookDossier, operationId: string): EnqueueTaskInput {
    return dossierTaskInput(row.id, row.sourceVersionId, operationId);
  }

  // -------------------------------------------------------------------------
  // Глоссарий
  // -------------------------------------------------------------------------

  private async startGlossary(
    dossier: BookDossier,
    language: Language,
    failed: BookGlossary | null,
    options: DemandOptions,
  ): Promise<BookGlossary | 'waiter-limit' | null> {
    const estimate = await this.estimateGlossary(dossier, language);
    const limitUsd = options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    if (!(await this.waiterFits(options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId: dossier.sourceVersionId,
      limitUsd,
      createdById: options.createdById ?? null,
      translationRunId: options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        let row: BookGlossary;
        if (failed) {
          // `failed -> building` условием: заново строит один (Р20), перехват снова разрешён.
          const reopened = await tx.bookGlossary.updateMany({
            where: { id: failed.id, status: 'failed' },
            data: {
              status: 'building',
              operationId: op.id,
              previousOperationId: null,
              takeovers: 0,
            },
          });
          if (reopened.count === 0) throw new TakeoverLostError();
          row = await tx.bookGlossary.findUniqueOrThrow({ where: { id: failed.id } });
        } else {
          row = await tx.bookGlossary.create({
            data: { dossierId: dossier.id, language, operationId: op.id },
          });
        }
        await this.tasks.enqueue(this.glossaryTask(row, dossier, op.id), tx);
        return row;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      if (isUniqueViolation(error) || error instanceof TakeoverLostError) return null;
      throw error;
    }
  }

  private async followGlossaryBuilder(
    row: BookGlossary,
    dossier: BookDossier,
    options: DemandOptions,
  ): Promise<Demand<BookGlossary> | null> {
    const op = await this.operationOf(row.operationId);
    const verdict = await this.builderVerdict(row, op, options, 'bookGlossary');
    if (verdict !== 'takeover') return verdict;
    const estimate = await this.estimateGlossary(dossier, row.language);
    const taken = await this.takeOver(
      row,
      'bookGlossary',
      estimate,
      options,
      dossier.sourceVersionId,
      (r, opId) => this.glossaryTask(r, dossier, opId),
    );
    return this.takeoverDemand(row, taken);
  }

  private glossaryTask(
    row: BookGlossary,
    dossier: BookDossier,
    operationId: string,
  ): EnqueueTaskInput {
    return glossaryTaskInput(row.id, row.language, dossier.sourceVersionId, operationId);
  }

  // -------------------------------------------------------------------------
  // Общее для строк досье и глоссария (Р20)
  // -------------------------------------------------------------------------

  /**
   * Что делать ждущему со строкой `building` по состоянию её строителя. `takeover` - строитель
   * `failed`, строку ещё не перехватывали и текст исходника тот же (`fresh`): перехват
   * устаревшей строки достроил бы досье по старым кускам. Строитель `done` при строке
   * `building` - строку уже никто не достроит, это тот же отказ.
   */
  private async builderVerdict<Row extends BookDossier | BookGlossary>(
    row: Row,
    op: LlmOperation | null,
    options: DemandOptions,
    model: 'bookDossier' | 'bookGlossary',
    fresh = true,
  ): Promise<Demand<Row> | 'takeover' | null> {
    switch (op?.status) {
      case 'active':
        return { status: 'wait', row };
      case 'paused':
        // Строитель на паузе (бюджет, поставщик): редактор продолжает досье, затем запуск.
        await this.pauseWaiter(options.waiter, 'DOSSIER_PAUSED');
        return { status: 'paused', row, reason: 'DOSSIER_PAUSED', builderOperationId: op.id };
      case 'failed':
        if (row.takeovers === 0 && fresh) return 'takeover';
        // Текст правили после отказа строителя: это не отказ ждущего. Строка закрывается
        // причиной, вызывающий перечитывает её и строит новое поколение по новому тексту.
        if (!fresh && model === 'bookDossier') {
          await this.failRow(model, row.id, row.operationId, this.prisma, {
            failedReason: DOSSIER_SOURCE_CHANGED,
          });
          return null;
        }
        break;
      default:
        // Отменён или операции нет: перехвата нет, отмена останавливает траты.
        break;
    }
    // Строка `failed` и пауза ждущего - одной транзакцией: обрыв между ними оставил бы ждущего
    // `active`, и его повтор завёл бы новое поколение с повторной оплатой (Р20).
    // Строку прочитали до её строителя: если она уже не `building` под ним (стала `ready`, её
    // перехватили), отказа нет - пауза откатывается, вызывающий перечитывает строку.
    const fail = async (tx: Prisma.TransactionClient) => {
      if ((await this.failRow(model, row.id, row.operationId, tx)) === 0) {
        throw new TakeoverLostError();
      }
    };
    try {
      if (options.waiter) {
        await this.tasks.pauseOperation(options.waiter.operationId, 'STEP_FAILED', fail);
      } else {
        await fail(this.prisma);
      }
    } catch (error) {
      if (error instanceof TakeoverLostError) return null;
      throw error;
    }
    return { status: 'failed', row: { ...row, status: 'failed' } };
  }

  /**
   * Перехват строки новой операцией на остаток оценки: условный UPDATE по прежнему строителю
   * и `takeovers = 0`. Задачи прежнего строителя уже `cancelled`: `failOperation` закрыл
   * `pending`, а `running` закроется сам, найдя операцию не `active`. Частичные досье остаются
   * у строки - повтор их не оплачивает.
   */
  private async takeOver<Row extends BookDossier | BookGlossary>(
    row: Row,
    model: 'bookDossier' | 'bookGlossary',
    estimate: Prisma.Decimal,
    options: DemandOptions,
    bookVersionId: string,
    taskOf: (row: Row, operationId: string) => EnqueueTaskInput,
  ): Promise<Row | 'waiter-limit' | null> {
    const limitUsd = options.limitUsd ?? estimate.mul(DOSSIER_LIMIT_FACTOR);
    // Кнопка перехватывает с лимитом редактора и не при исчерпанном потолке - как новое поколение.
    this.llm.assertEnabled();
    if (!options.waiter) await this.assertCeilingRoom();
    if (!(await this.waiterFits(options, limitUsd))) return 'waiter-limit';
    const opData = await this.llm.operationData({
      kind: 'dossier',
      bookVersionId,
      limitUsd,
      createdById: options.createdById ?? null,
      translationRunId: options.waiter?.translationRunId ?? null,
    });
    try {
      return await this.prisma.$transaction(async (tx) => {
        const op = await tx.llmOperation.create({ data: opData, select: { id: true } });
        const where = {
          id: row.id,
          status: 'building' as const,
          operationId: row.operationId,
          takeovers: 0,
        };
        const data = { operationId: op.id, previousOperationId: row.operationId, takeovers: 1 };
        const taken =
          model === 'bookDossier'
            ? await tx.bookDossier.updateMany({ where, data })
            : await tx.bookGlossary.updateMany({ where, data });
        if (taken.count === 0) throw new TakeoverLostError();
        const updated = { ...row, ...data };
        await this.tasks.enqueue(taskOf(updated, op.id), tx);
        return updated;
      }, BUILD_TX_OPTIONS);
    } catch (error) {
      if (error instanceof TakeoverLostError) return null;
      throw error;
    }
  }

  /**
   * Строка не влезла в контекст при том же тексте и той же модели этапа: новое поколение
   * отказало бы так же, его заводит только явная кнопка (уточнение Р20).
   */
  private async tooLongAgain(row: BookDossier, fresh: boolean): Promise<boolean> {
    if (row.failedReason !== DOSSIER_TOO_LONG || !fresh) return false;
    const { model } = await this.llm.getStageSetting(DOSSIER_STAGE);
    return row.model === model;
  }

  private takeoverDemand<Row>(row: Row, taken: Row | 'waiter-limit' | null): Demand<Row> | null {
    if (taken === 'waiter-limit') {
      return { status: 'paused', row, reason: 'LIMIT_REACHED', builderOperationId: null };
    }
    return taken ? { status: 'wait', row: taken } : null;
  }

  /**
   * Ждущий заводит операцию досье (новое поколение, перехват) только в пределах своего лимита
   * (карточка, шаг 7; Р20): иначе она обходила бы его LIMIT_REACHED. Не влезло - ждущий на паузе.
   * Без ждущего (кнопка) лимит - у новой операции.
   */
  private async waiterFits(options: DemandOptions, limitUsd: Prisma.Decimal): Promise<boolean> {
    if (!options.waiter) return true;
    const op = await this.prisma.llmOperation.findUnique({
      where: { id: options.waiter.operationId },
      select: { limitUsd: true, spentUsd: true, reservedUsd: true },
    });
    // Операции ждущего нет - не помещается ни с каким лимитом: пауза без суммы.
    const minLimit = op ? waiterMinLimit(op, limitUsd) : null;
    if (op && minLimit === null) return true;
    const { onLimit } = options.waiter;
    await this.tasks.pauseOperation(
      options.waiter.operationId,
      'LIMIT_REACHED',
      onLimit && minLimit ? (tx) => onLimit(tx, minLimit) : undefined,
    );
    return false;
  }

  /**
   * `building -> failed` условием по строителю: строку уже мог перехватить другой. Причина
   * пишется только досье: у глоссария колонки `failedReason` нет, и сигнатура её не примет.
   */
  async failRow(
    model: 'bookDossier',
    id: string,
    operationId: string | null,
    db?: Prisma.TransactionClient,
    reason?: DossierFailure,
  ): Promise<number>;
  async failRow(
    model: 'bookDossier' | 'bookGlossary',
    id: string,
    operationId: string | null,
    db?: Prisma.TransactionClient,
  ): Promise<number>;
  async failRow(
    model: 'bookDossier' | 'bookGlossary',
    id: string,
    operationId: string | null,
    db: Prisma.TransactionClient = this.prisma,
    reason?: DossierFailure,
  ): Promise<number> {
    const where = { id, status: 'building' as const, operationId };
    const closed =
      model === 'bookDossier'
        ? await db.bookDossier.updateMany({ where, data: { status: 'failed', ...reason } })
        : await db.bookGlossary.updateMany({ where, data: { status: 'failed' } });
    return closed.count;
  }

  private async pauseWaiter(
    waiter: DossierWaiter | undefined,
    reason: LlmPauseReason,
  ): Promise<void> {
    if (waiter) await this.tasks.pauseOperation(waiter.operationId, reason);
  }

  private operationOf(id: string | null): Promise<LlmOperation | null> {
    return id ? this.prisma.llmOperation.findUnique({ where: { id } }) : Promise.resolve(null);
  }

  private async estimatePlans(
    plans: DossierPartPlan[],
    chapters: FingerprintChapter[],
    allPlans: DossierPartPlan[] = plans,
  ): Promise<Prisma.Decimal> {
    const call = await this.estimator(DOSSIER_STAGE);
    let total = new Prisma.Decimal(0);
    for (const plan of plans) total = total.add(call.estimate(dossierPartRequest(plan)));
    // Вход сводки - частичные досье всех кусков. Ответ куска не длиннее `maxTokens` токенов, то
    // есть до `maxTokens × CHARS_PER_TOKEN` символов JSON, а резерв клиента считает символ за токен.
    const summary = dossierSummaryRequest({
      chapters: chapters.map((c) => ({ number: c.number, title: c.title })),
      parts: [],
    });
    return total.add(call.estimate(summary, summaryAnswersChars(allPlans.length, call)));
  }

  private async estimateGlossary(
    dossier: BookDossier,
    language: Language,
  ): Promise<Prisma.Decimal> {
    const call = await this.estimator(GLOSSARY_STAGE);
    return call.estimate(glossaryRequest({ dossier: dossier.data, language }));
  }

  private async assertCeilingRoom(): Promise<void> {
    if (await this.budget.ceilingReached()) {
      throw llmTaskConflict('LLM_CEILING_REACHED', 'LLM spending ceiling is reached');
    }
  }

  /**
   * Оценщик вызова этапа для ручек: модель этапа без цены и без `maxPricePerMTok` - 409 с кодом
   * `LLM_NO_PRICE`, а не 500 (`LlmError` в HTTP сам не переводится).
   */
  private async estimator(stage: string): Promise<StageCallEstimator> {
    let call: StageCallEstimator;
    try {
      call = await this.llm.stageCallEstimator(stage);
    } catch (error) {
      if (error instanceof LlmError) throw llmTaskConflict(error.code, error.message);
      throw error;
    }
    // Выключенный этап - отказ до операции, а не операция, которая откажет на первом шаге.
    if (!call.enabled) {
      throw llmTaskConflict('LLM_STAGE_DISABLED', `LLM stage "${stage}" is disabled`);
    }
    return call;
  }

  private noChapters(): ConflictException {
    return llmTaskConflict(
      'SOURCE_HAS_NO_CHAPTERS',
      'The dossier source version has no chapter text',
    );
  }

  /**
   * Досье и глоссарий запуска, создавшего эту версию (`TranslationRunLanguage.bookVersionId`,
   * Р18): статус досье и заготовка (`F05-10`) берут их без проверки свежести. `null` - версия
   * ручная или исходник. Одно чтение связи на оба места: правило Р18 живёт здесь.
   */
  async runContextOf(versionId: string): Promise<{
    sourceVersionId: string;
    dossier: BookDossier | null;
    glossaryId: string | null;
    status: TranslationRunLanguageStatus;
  } | null> {
    const linked = await this.prisma.translationRunLanguage.findUnique({
      where: { bookVersionId: versionId },
      select: {
        glossaryId: true,
        status: true,
        run: { select: { bookVersionId: true, dossier: true } },
      },
    });
    return linked
      ? {
          sourceVersionId: linked.run.bookVersionId,
          dossier: linked.run.dossier,
          glossaryId: linked.glossaryId,
          status: linked.status,
        }
      : null;
  }

  /**
   * Досье и глоссарий запуска для заготовки (`F05-10`, решение арбитра `F05 | F05-10`, Р2): язык
   * запуска ещё пишет главы - 409 `RUN_LANGUAGE_UNFINISHED` (платить за недописанный текст
   * нельзя); `done`, `failed`, `cancelled` - досье и глоссарий запуска по Р18.
   */
  async finishedRunContextOf(
    versionId: string,
  ): Promise<{ dossier: BookDossier | null; glossaryId: string | null } | null> {
    const run = await this.runContextOf(versionId);
    if (run && (run.status === 'pending' || run.status === 'running')) {
      throw llmTaskConflict(
        'RUN_LANGUAGE_UNFINISHED',
        'The translation run is still writing this version: wait until it finishes',
      );
    }
    return run;
  }

  /** Досье запуска, создавшего эту версию (Р18); иначе `null`. */
  private async runDossierOf(
    versionId: string,
  ): Promise<{ sourceVersionId: string; row: BookDossier | null } | null> {
    const run = await this.runContextOf(versionId);
    return run ? { sourceVersionId: run.sourceVersionId, row: run.dossier } : null;
  }

  /** Ответ `status` по выбранной строке досье и её свежести. */
  private async statusOf(
    sourceVersionId: string,
    row: BookDossier | null,
    fresh: Promise<boolean> | boolean | null,
  ): Promise<DossierStatusDto> {
    const [isFresh, partsDone, operation, previousOperation] = row
      ? await Promise.all([
          fresh,
          this.prisma.bookDossierPart.count({ where: { dossierId: row.id } }),
          this.operationOf(row.operationId),
          this.operationOf(row.previousOperationId),
        ])
      : [null, 0, null, null];
    return toDossierStatusDto({
      sourceVersionId,
      row,
      fresh: isFresh,
      partsDone,
      operation,
      previousOperation,
    });
  }
}

/**
 * Задача досье. Ключ пары - «операция:строка»: «продолжить», пока прежний шаг ещё идёт,
 * находит его держателем и второй задачи не ставит (`LlmTaskService.resumeOperation`) - иначе
 * два шага строили бы одну строку и платили дважды.
 */
export function dossierTaskInput(
  dossierId: string,
  sourceVersionId: string,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: DOSSIER_TASK_KIND,
    operationId,
    bookVersionId: sourceVersionId,
    payload: { dossierId },
    pairKey: `${operationId}:${dossierId}`,
  };
}

/** Задача глоссария; ключ пары - как у досье. */
export function glossaryTaskInput(
  glossaryId: string,
  language: Language,
  sourceVersionId: string,
  operationId: string,
): EnqueueTaskInput {
  return {
    kind: GLOSSARY_TASK_KIND,
    operationId,
    bookVersionId: sourceVersionId,
    language,
    payload: { glossaryId },
    pairKey: `${operationId}:${glossaryId}`,
  };
}

/**
 * Вход сводки из ответов кусков в символах (резерв считает символ за токен): каждый ответ - до
 * `maxTokens` токенов, но вызов больше контекста модели не уйдёт (`stageFit`), поэтому сверху -
 * контекст в символах. Без потолка лимит длинной книги раздувался бы на порядки.
 */
function summaryAnswersChars(parts: number, call: StageCallEstimator): number {
  const answers = parts * call.maxTokens * CHARS_PER_TOKEN;
  return call.contextLength === null
    ? answers
    : Math.min(answers, call.contextLength * CHARS_PER_TOKEN);
}

/**
 * Лимит ждущего, с которым операция досье или глоссария поместится: потрачено + в резерве + её
 * лимит, вверх до восьми знаков - деньги хранятся `Decimal(14,8)`, и округлённый вниз минимум
 * не пропустил бы «продолжить» с показанной суммой (`F05-7`). `null` - помещается и так.
 */
export function waiterMinLimit(
  op: { limitUsd: Prisma.Decimal; spentUsd: Prisma.Decimal; reservedUsd: Prisma.Decimal },
  needed: Prisma.Decimal,
): Prisma.Decimal | null {
  const min = op.spentUsd
    .add(op.reservedUsd)
    .add(needed)
    .toDecimalPlaces(8, Prisma.Decimal.ROUND_UP);
  return op.limitUsd.gte(min) ? null : min;
}
