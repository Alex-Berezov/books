import { Injectable, NotFoundException } from '@nestjs/common';
import {
  BookDossier,
  BookGlossary,
  Language,
  Prisma,
  TranslationRunLanguageStatus,
  LlmOperation,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { ANSWER_CHARS_PER_TOKEN } from '../../llm/openrouter.client';
import { LlmService } from '../../llm/llm.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { sourceFingerprint } from '../source-fingerprint';
import { TranslationSourceService } from '../translation-source.service';
import {
  DOSSIER_LIMIT_FACTOR,
  DOSSIER_STAGE,
  DOSSIER_TOO_LONG,
  GLOSSARY_STAGE,
} from './dossier.constants';
import { DossierBuilderService } from './dossier-builder.service';
import { Demand, DemandOptions, DossierWaiter } from './dossier-demand.types';
import { DossierEstimatesService } from './dossier-estimates.service';
import { partKey, planPartsCount, readPlan } from './dossier-parts';
import { dossierTaskInput, glossaryTaskInput } from './dossier-task-input';
import { glossaryRequest } from './dossier.prompts';

export interface DossierEstimate {
  sourceVersionId: string;
  chapters: number;
  parts: number;
  estimateUsd: Prisma.Decimal;
  suggestedLimitUsd: Prisma.Decimal;
  /** Старт откажет `DOSSIER_TOO_LONG` до кусков (`findRefusingModel`); сумма остаётся оценкой (`T147`). */
  refusedTooLong: boolean;
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

/**
 * Досье и глоссарий (`F05-2`, шаг 7, Р5, Р20). Строитель строки один: строка `building`
 * создаётся вставкой с уникальным ключом, проигравший ждёт. Построение - задачи исполнителя
 * под **своей** операцией вида `dossier` с лимитом оценка × 1,5, а не под операцией ждущего.
 *
 * Перехват - только у строителя в `failed` и один раз на строку; строитель на паузе - ждущий
 * встаёт на паузу `DOSSIER_PAUSED`; отменённый строитель или второй отказ - строка `failed`.
 */
@Injectable()
export class DossierDemandService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly sources: TranslationSourceService,
    private readonly estimates: DossierEstimatesService,
    private readonly builder: DossierBuilderService,
  ) {}

  /** Версия, чьё досье берёт открытая версия (Р5), и книга. */
  async dossierSourceOf(versionId: string): Promise<{ bookId: string; sourceVersionId: string }> {
    const { bookId, dossierSourceVersionId } = await this.sources.forVersion(versionId);
    return { bookId, sourceVersionId: dossierSourceVersionId };
  }

  latestDossier(sourceVersionId: string): Promise<BookDossier | null> {
    return this.prisma.bookDossier.findFirst({
      where: { sourceVersionId },
      orderBy: { generation: 'desc' },
    });
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
            : glossaryLine(await this.estimates.estimateGlossary(latest, language), false),
        );
      }
      return { sourceVersionId, dossier: null, glossaries };
    }
    const [dossier, call, dossierCall] = await Promise.all([
      latest?.status === 'building' ? null : this.estimateOf(versionId),
      this.estimates.estimator(GLOSSARY_STAGE),
      this.estimates.estimator(DOSSIER_STAGE),
    ]);
    for (const language of languages) {
      const upper = call.estimate(
        glossaryRequest({ dossier: null, language }),
        dossierCall.maxTokens * ANSWER_CHARS_PER_TOKEN,
      );
      glossaries.set(language, glossaryLine(upper, true));
    }
    return { sourceVersionId, dossier, glossaries };
  }

  async estimateOf(versionId: string): Promise<DossierEstimate> {
    const { sourceVersionId } = await this.dossierSourceOf(versionId);
    const { estimateUsd, entries, parts, titles } =
      await this.estimates.estimateSource(sourceVersionId);
    return {
      sourceVersionId,
      chapters: entries.length,
      parts,
      estimateUsd,
      suggestedLimitUsd: estimateUsd.mul(DOSSIER_LIMIT_FACTOR),
      // То же правило, что у старта: оценка не обещает построение, которому старт откажет.
      refusedTooLong: (await this.estimates.findRefusingModel(titles, entries.length)) !== null,
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
        // Отказ перехвата (`failTakeover`) отвечает и кнопке: новое поколение отказало бы тем же
        // правилом и завело бы вторую строку `failed`.
        if (
          followed &&
          (followed.status !== 'failed' ||
            options.waiter ||
            followed.row.failedReason === DOSSIER_TOO_LONG)
        ) {
          return { ...followed, fresh: followed.row ? fresh(followed.row) : true };
        }
        continue;
      }
      if (
        latest?.status === 'failed' &&
        options.waiter &&
        (await this.waiterRefused(latest, fresh(latest), options.waiter))
      ) {
        await this.builder.pauseWaiter(options.waiter, 'STEP_FAILED');
        return { status: 'failed', row: latest, fresh: fresh(latest) };
      }
      // Нет строки, `failed` не нашего ожидания или устаревшее по кнопке - новое поколение.
      const started = await this.builder.startDossier({
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
      // Отказ на старте (`F05-13b`): ждущий уже на паузе той же транзакцией, что и строка.
      if (started?.status === 'failed') return { status: 'failed', row: started, fresh: true };
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
        await this.builder.pauseWaiter(options.waiter, 'STEP_FAILED');
        return { status: 'failed', row };
      }
      const started = await this.builder.startGlossary(dossier, language, row, options);
      if (started === 'waiter-limit') {
        return { status: 'paused', row, reason: 'LIMIT_REACHED', builderOperationId: null };
      }
      if (started) return { status: 'wait', row: started };
    }
    throw llmTaskConflict('GLOSSARY_BUSY', 'Glossary is being changed concurrently, try again');
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
    const verdict = await this.builder.builderVerdict(row, op, options, 'bookDossier', fresh);
    if (verdict !== 'takeover') return verdict;
    const done = await this.prisma.bookDossierPart.findMany({
      where: { dossierId: row.id },
      select: { chapterNumber: true, partIndex: true },
      take: planPartsCount(readPlan(row.plan)),
    });
    const saved = new Set(done.map((p) => partKey(p.chapterNumber, p.partIndex)));
    // Сводка оценивается по всем кускам: её вход - все частичные, и уже сохранённые тоже.
    const {
      estimateUsd: estimate,
      entries,
      titles,
    } = await this.estimates.estimateSource(row.sourceVersionId, saved);
    // Модель этапа сменили на узкую после старта: перехват дооплатил бы куски, а обработчик
    // отказал бы тем же правилом. Строка закрывается без новой операции (`LEGACY-477`, `T147`).
    const refusing = await this.estimates.findRefusingModel(titles, entries.length);
    if (refusing) return this.builder.failTakeover(row, refusing, options);
    const taken = await this.builder.takeOver(
      row,
      'bookDossier',
      estimate,
      options,
      row.sourceVersionId,
      (r, opId) => dossierTaskInput(r.id, r.sourceVersionId, opId),
    );
    return this.takeoverDemand(row, taken);
  }

  private async followGlossaryBuilder(
    row: BookGlossary,
    dossier: BookDossier,
    options: DemandOptions,
  ): Promise<Demand<BookGlossary> | null> {
    const op = await this.operationOf(row.operationId);
    const verdict = await this.builder.builderVerdict(row, op, options, 'bookGlossary');
    if (verdict !== 'takeover') return verdict;
    const estimate = await this.estimates.estimateGlossary(dossier, row.language);
    const taken = await this.builder.takeOver(
      row,
      'bookGlossary',
      estimate,
      options,
      dossier.sourceVersionId,
      (r, opId) => glossaryTaskInput(r.id, r.language, dossier.sourceVersionId, opId),
    );
    return this.takeoverDemand(row, taken);
  }

  /**
   * `failed` - отказ ждущего. Строка ждущего упала на том же тексте - его отказ; текст правили -
   * строят новое поколение по новому тексту, а не стоят на STEP_FAILED. Строка, закрытая правилом
   * старта, судится только этим правилом (`tooLongAgain`) - и для ждущего, который её ждал: перехват
   * закрывает строку, которую ждал запуск, и иначе снятие отказа до него не дошло бы (`T147`, (ж)).
   */
  private async waiterRefused(
    row: BookDossier,
    fresh: boolean,
    waiter: DossierWaiter,
  ): Promise<boolean> {
    const own = waiter.waitingFor === row.id && fresh;
    if (own && !(row.failedReason === DOSSIER_TOO_LONG && (await this.closedAtStart(row)))) {
      return true;
    }
    return this.tooLongAgain(row, fresh);
  }

  /**
   * Строка не влезла в контекст при том же тексте и той же модели этапа: новое поколение
   * отказало бы так же, его заводит только явная кнопка (уточнение Р20). Строка, закрытая на
   * старте или на перехвате тем же правилом (`closedAtStart`), перепроверяется текущими
   * настройками этапа: это правило детерминировано, и смена одного `maxTokens` или контекста
   * модели его снимает (`T147`).
   */
  private async tooLongAgain(row: BookDossier, fresh: boolean): Promise<boolean> {
    if (row.failedReason !== DOSSIER_TOO_LONG || !fresh) return false;
    if (await this.closedAtStart(row)) {
      const { titles, entries } = await this.estimates.walkSource(
        row.sourceVersionId,
        () => undefined,
      );
      return (await this.estimates.findRefusingModel(titles, entries.length)) !== null;
    }
    const { model } = await this.llm.getStageSetting(DOSSIER_STAGE);
    return row.model === model;
  }

  /**
   * Строка закрыта правилом старта: на старте (`failAtStart` - ни операции, ни кусков) или на
   * перехвате (`failTakeover` - строитель в `previousOperationId` без перехвата, `takeovers` 0).
   * Куски проверяются, а не одна пустая `operationId`: связь с операцией `SetNull`, и строка
   * обработчика с удалённой операцией иначе ушла бы на перепроверку (решение арбитра `T147`, (ж)).
   */
  private async closedAtStart(row: BookDossier): Promise<boolean> {
    if (row.operationId !== null) return false;
    if (row.previousOperationId !== null && row.takeovers === 0) return true;
    const part = await this.prisma.bookDossierPart.findFirst({
      where: { dossierId: row.id },
      select: { dossierId: true },
    });
    return part === null;
  }

  operationOf(id: string | null): Promise<LlmOperation | null> {
    return id ? this.prisma.llmOperation.findUnique({ where: { id } }) : Promise.resolve(null);
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

  private takeoverDemand<Row>(row: Row, taken: Row | 'waiter-limit' | null): Demand<Row> | null {
    if (taken === 'waiter-limit') {
      return { status: 'paused', row, reason: 'LIMIT_REACHED', builderOperationId: null };
    }
    return taken ? { status: 'wait', row: taken } : null;
  }
}
