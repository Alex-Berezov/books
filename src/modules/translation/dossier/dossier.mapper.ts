import { BookDossier, BookGlossary, LlmOperation, Prisma } from '@prisma/client';
import { moneyUsd } from '../../llm/dto/llm-money';
import { toOperationDto } from '../../llm-worker/llm-operation.mapper';
import { DossierEstimateDto, DossierStatusDto, GlossaryDto } from '../dto/translation-response.dto';
import { DossierDataDto, GlossaryDataDto, GlossaryHistoryItemDto } from '../dto/dossier-data.dto';
import { DossierEstimate } from './dossier.service';

function record(value: Prisma.JsonValue | null): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Данные досье и глоссария пишутся только после проверки формы (`shapeErrors`), поэтому
 * читаются типом формата без второй проверки.
 */
function dossierData(value: Prisma.JsonValue | null): DossierDataDto | null {
  return record(value) as DossierDataDto | null;
}

function glossaryData(value: Prisma.JsonValue | null): GlossaryDataDto | null {
  return record(value) as GlossaryDataDto | null;
}

/** История пишется `F05-4`; элемент без списка записей пропускается, а не роняет ответ. */
function glossaryHistory(value: Prisma.JsonValue): GlossaryHistoryItemDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((h) => {
    const item = record(h);
    if (!item || !Array.isArray(item.entries)) return [];
    return [
      {
        chunkId: typeof item.chunkId === 'string' ? item.chunkId : null,
        entries: item.entries as GlossaryHistoryItemDto['entries'],
      },
    ];
  });
}

export function toEstimateDto(e: DossierEstimate): DossierEstimateDto {
  return {
    sourceVersionId: e.sourceVersionId,
    chapters: e.chapters,
    parts: e.parts,
    estimateUsd: moneyUsd(e.estimateUsd),
    suggestedLimitUsd: moneyUsd(e.suggestedLimitUsd),
  };
}

export function toDossierStatusDto(input: {
  sourceVersionId: string;
  row: BookDossier | null;
  fresh: boolean | null;
  partsDone: number;
  operation: LlmOperation | null;
  previousOperation: LlmOperation | null;
}): DossierStatusDto {
  const { row } = input;
  return {
    status: row?.status ?? 'missing',
    id: row?.id ?? null,
    sourceVersionId: input.sourceVersionId,
    generation: row?.generation ?? null,
    fresh: row ? input.fresh : null,
    formatVersion: row?.status === 'ready' ? row.formatVersion : null,
    model: row?.model ?? null,
    partsDone: input.partsDone,
    failedReason: row?.failedReason ?? null,
    operation: input.operation ? toOperationDto(input.operation) : null,
    previousOperation: input.previousOperation ? toOperationDto(input.previousOperation) : null,
    data: row?.status === 'ready' ? dossierData(row.data) : null,
    updatedAt: row ? row.updatedAt.toISOString() : null,
  };
}

export function toGlossaryDto(
  row: BookGlossary,
  operation: LlmOperation | null,
  previousOperation: LlmOperation | null,
): GlossaryDto {
  return {
    id: row.id,
    dossierId: row.dossierId,
    language: row.language,
    status: row.status,
    data: row.status === 'ready' ? glossaryData(row.data) : null,
    history: glossaryHistory(row.history),
    model: row.model,
    operation: operation ? toOperationDto(operation) : null,
    previousOperation: previousOperation ? toOperationDto(previousOperation) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}
