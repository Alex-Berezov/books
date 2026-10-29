import { Injectable, NotFoundException } from '@nestjs/common';
import { BookDossier, Language, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { LlmService } from '../../llm/llm.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { sourceFingerprint } from '../source-fingerprint';
import { DossierEstimateDto, DossierStatusDto, GlossaryDto } from '../dto/translation-response.dto';
import { DossierDemandService } from './dossier-demand.service';
import { toDossierStatusDto, toEstimateDto, toGlossaryDto } from './dossier.mapper';

/**
 * Досье для админки (`F05-2`): состояние, глоссарий, кнопка «построить» и оценка. Спрос
 * на досье и глоссарий и их строители - `DossierDemandService`, зависимость только туда.
 */
@Injectable()
export class DossierService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly demand: DossierDemandService,
  ) {}

  /**
   * Состояние досье версии для админки: старшее поколение её исходника (Р5), свежесть по
   * отпечатку и операция строителя. Версия, созданная переводом, берёт досье своего запуска без
   * признака «устарел» (Р18, `F05-6`, 6b; решение арбитра `F05 | F05-4b`): правка исходника после
   * запуска досье перевода не меняет. Ручная версия и исходник - как прежде.
   */
  async status(versionId: string): Promise<DossierStatusDto> {
    const own = await this.runDossierOf(versionId);
    if (own) return this.statusOf(own.sourceVersionId, own.row, true);
    const { sourceVersionId } = await this.demand.dossierSourceOf(versionId);
    const row = await this.demand.latestDossier(sourceVersionId);
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
      this.demand.operationOf(row.operationId),
      this.demand.operationOf(row.previousOperationId),
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
    const demand = await this.demand.demandDossier(versionId, {
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
    return toEstimateDto(await this.demand.estimateOf(versionId));
  }

  /** Досье запуска, создавшего эту версию (Р18); иначе `null`. */
  private async runDossierOf(
    versionId: string,
  ): Promise<{ sourceVersionId: string; row: BookDossier | null } | null> {
    const run = await this.demand.runContextOf(versionId);
    return run ? { sourceVersionId: run.sourceVersionId, row: run.dossier } : null;
  }

  /** Ответ `status` по выбранной строке досье и её свежести. */
  private async statusOf(
    sourceVersionId: string,
    row: BookDossier | null,
    fresh: Promise<boolean> | boolean | null,
  ): Promise<DossierStatusDto> {
    const [isFresh, partsDone, groupsByDone, operation, previousOperation] = row
      ? await Promise.all([
          fresh,
          this.prisma.bookDossierPart.count({ where: { dossierId: row.id } }),
          // Готовые и все группы - одним запросом: статус опрашивают, пока досье строится.
          this.prisma.bookDossierGroup.groupBy({
            by: ['done'],
            where: { dossierId: row.id },
            _count: { _all: true },
          }),
          this.demand.operationOf(row.operationId),
          this.demand.operationOf(row.previousOperationId),
        ])
      : [null, 0, [], null, null];
    const groupsDone = groupsByDone.find((g) => g.done)?._count._all ?? 0;
    const groupsTotal = groupsByDone.reduce((sum, g) => sum + g._count._all, 0);
    return toDossierStatusDto({
      sourceVersionId,
      row,
      fresh: isFresh,
      partsDone,
      groupsDone,
      groupsTotal,
      operation,
      previousOperation,
    });
  }
}
