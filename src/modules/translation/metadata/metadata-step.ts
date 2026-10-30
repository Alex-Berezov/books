import { Language, Prisma } from '@prisma/client';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { LlmError } from '../../llm/llm.errors';
import { LlmService, StageCallEstimator } from '../../llm/llm.service';
import { LlmTaskContext } from '../../llm-worker/llm-task.types';
import { ChapterLayout, splitChapter } from '../chapter-blocks';
import { allChapters } from '../chapter-pages';
import { NameEntry, nameEntriesOf } from '../check/mechanical-check';
import { callShaped } from '../llm-shaped-call';
import { StageModels } from '../run/run-models';
import { glossaryFor } from '../translate/translate-piece';
import { metadataFormErrors, MetadataSource, plainLine } from './metadata-check';
import { METADATA_REMARKS, METADATA_STAGE } from './metadata.constants';
import { MetadataAnswer, MetadataInput, metadataRequest, METADATA_SHAPE } from './metadata.prompts';

/** Поля исходника, которые переводит этап: версия и названия её глав. */
export interface MetadataSourceFields {
  sourceLanguage: Language;
  targetLanguage: Language;
  title: string;
  author: string;
  description: string;
  chapterTitles: Array<{ number: number; title: string }>;
}

/**
 * Поля исходника для этапа - одна выборка на шаг и оценку: название, автор, описание и названия
 * глав по номерам. Версии нет - `null`.
 */
export async function metadataSourceFields(
  db: Prisma.TransactionClient,
  versionId: string,
  sourceLanguage: Language,
): Promise<Omit<MetadataSourceFields, 'targetLanguage'> | null> {
  const version = await db.bookVersion.findUnique({
    where: { id: versionId },
    select: {
      title: true,
      author: true,
      description: true,
    },
  });
  if (!version) return null;
  const chapters = await allChapters(db, versionId, { number: true, title: true });
  return {
    sourceLanguage,
    title: version.title,
    author: version.author,
    description: version.description,
    chapterTitles: chapters,
  };
}

/**
 * Вход этапа и данные проверок - одно правило на шаг и оценку: описание блоками (`splitChapter`),
 * записи глоссария, встреченные в полях (`glossaryFor`, как у куска).
 */
export function metadataInputOf(
  fields: MetadataSourceFields,
  context: { glossary: unknown; dossier: unknown },
  remarks: readonly string[] = [],
): { input: MetadataInput; source: MetadataSource } {
  const layout: ChapterLayout = splitChapter(fields.description);
  const description = layout.blocks
    .filter((b) => b.translatable)
    .map((b) => ({ n: b.n, kind: b.kind, html: b.html }));
  const text = [
    fields.title,
    plainLine(fields.author),
    ...description.map((b) => richHtmlText(b.html)),
    ...fields.chapterTitles.map((c) => c.title),
  ].join('\n');
  const glossary = glossaryFor(context.glossary, context.dossier, text);
  const names: NameEntry[] = nameEntriesOf(glossary.entries);
  return {
    input: {
      sourceLanguage: fields.sourceLanguage,
      targetLanguage: fields.targetLanguage,
      title: fields.title,
      author: fields.author,
      description,
      chapterTitles: fields.chapterTitles,
      glossary,
      ...(remarks.length > 0 ? { remarks } : {}),
    },
    source: {
      sourceLanguage: fields.sourceLanguage,
      targetLanguage: fields.targetLanguage,
      title: fields.title,
      author: fields.author,
      descriptionLayout: layout,
      chapterTitles: fields.chapterTitles,
      glossary: names,
    },
  };
}

/**
 * Итог вызова этапа. `too_long` - вход не влезает в контекст модели, вызова нет; `no_provider` -
 * все модели отказали по политике данных, `models` - что передано в вызов; `invalid` - ответ
 * не по форме после повтора с замечанием. Прочие отказы модуля LLM уходят вызывающему.
 */
export type MetadataOutcome =
  | { kind: 'too_long' }
  | { kind: 'no_provider'; models: StageModels }
  | { kind: 'invalid'; costUsd: Prisma.Decimal }
  | { kind: 'answered'; answer: MetadataAnswer; model: string; costUsd: Prisma.Decimal };

export async function callMetadata(
  llm: LlmService,
  operationId: string,
  input: MetadataInput,
  ctx: LlmTaskContext,
  models: StageModels,
): Promise<MetadataOutcome> {
  const request = metadataRequest(input);
  const fit = await llm.stageFit(METADATA_STAGE, request, models.model, models.fallbacks);
  if (!fit.fits) return { kind: 'too_long' };
  const chapters = input.chapterTitles.map((c) => c.number);
  try {
    const answer = await callShaped(
      llm,
      operationId,
      METADATA_STAGE,
      request,
      METADATA_SHAPE,
      ctx,
      {
        remarks: METADATA_REMARKS,
        model: models.model,
        fallbacks: models.fallbacks,
        extraErrors: (value) => metadataFormErrors(value, input.description, chapters),
      },
    );
    if (!answer.ok) return { kind: 'invalid', costUsd: answer.costUsd };
    return {
      kind: 'answered',
      answer: answer.value as MetadataAnswer,
      model: answer.model,
      costUsd: answer.costUsd,
    };
  } catch (error) {
    if (error instanceof LlmError && error.code === 'LLM_NO_COMPLIANT_PROVIDER') {
      return { kind: 'no_provider', models };
    }
    throw error;
  }
}

/**
 * Этап `metadata` в оценке запуска (`F05-6`, 6a): один вызов на язык, вход - тот же, что у шага
 * (`metadataInputOf`), выход - `maxTokens` этапа; `extra` - вход сверх промпта, пока досье
 * и глоссарий не готовы (как у перевода, `chapterTranslateUsd`). Повтор после провала проверок
 * оценка не считает, как и повторы перевода (решение арбитра `F05 | F05-5`).
 */
export function metadataUsd(
  call: StageCallEstimator,
  fields: MetadataSourceFields,
  context: { glossary: unknown; dossier: unknown; extra: number },
): Prisma.Decimal {
  return call.estimate(metadataRequest(metadataInputOf(fields, context).input), context.extra);
}
