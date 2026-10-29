import { Language } from '@prisma/client';
import { LlmChatMessage } from '../../llm/openrouter.client';
import { ChapterLayout } from '../chapter-blocks';
import { Shape } from '../dossier/dossier.format';
import { LANGUAGE_NAMES, shapedRequest } from '../dossier/dossier.prompts';
import { FENCE_RULE, fenced } from '../fenced-data';
import { TranslatedBlock } from '../translate/translate.format';
import { chunkBlocks } from '../translate/translate-piece';
import { pieceTexts } from './mechanical-check';

/**
 * Стык кусков моделью (`F05-6`, шаг 3; `product.md` §4, «Глава»): окно «2 блока до и 2 после»
 * каждого стыка главы - читается связно, ничего не потеряно и не повторено. Этап - `check_semantic`
 * со своим промптом, модели - другого семейства, чем модели обоих кусков стыка (решение арбитра
 * `F05 | F05-6`, 6c В4). Провал - флаг главы с номером стыка, не повтор.
 */

/** Блоков окна с каждой стороны стыка. */
export const SEAM_WINDOW_BLOCKS = 2;

/** Пропусков и повторов из ответа в находке не больше, каждый не длиннее: текст чужой модели. */
export const SEAM_PROBLEMS_MAX = 5;
export const SEAM_PROBLEM_MAX_CHARS = 300;

/**
 * Коды находок стыка моделью в `TranslationChapter.findings`. `SEAM_CHECKED` - ответ без провала:
 * запись оплаченного ответа, а не флаг; остальные - флаг главы, глава пишется (решение арбитра
 * `F05 | F05-6`, «глава с флагом стыка пишется»).
 */
export const SEAM_FINDING_CODES = {
  SEAM_CHECKED: 'SEAM_CHECKED',
  /** Модель нашла на стыке потерю, повтор или разрыв. */
  SEAM_BROKEN: 'SEAM_BROKEN',
  /** Все модели этапа - того же семейства, что модели кусков стыка. */
  SEAM_NOT_INDEPENDENT: 'SEAM_NOT_INDEPENDENT',
  SEAM_CHECK_UNAVAILABLE: 'SEAM_CHECK_UNAVAILABLE',
  SEAM_CHECK_INPUT_TOO_LONG: 'SEAM_CHECK_INPUT_TOO_LONG',
  SEAM_CHECK_INVALID_RESPONSE: 'SEAM_CHECK_INVALID_RESPONSE',
} as const;

export type SeamFindingCode = (typeof SEAM_FINDING_CODES)[keyof typeof SEAM_FINDING_CODES];

const SEAM_CODES: ReadonlySet<string> = new Set(Object.values(SEAM_FINDING_CODES));

/** Находка стыка моделью: номер стыка (с 1, как у `SEAM_REPEAT`), модель и стоимость ответа. */
export interface SeamFinding {
  code: SeamFindingCode;
  seam: number;
  model?: string;
  costUsd?: string;
  problems?: string[];
}

const SEAM_VERDICTS = ['pass', 'fail', 'unsure'] as const;

export const SEAM_SHAPE: Shape = {
  object: { verdict: { enum: [...SEAM_VERDICTS] }, problems: { array: 'string' } },
};

export interface SeamAnswer {
  verdict: (typeof SEAM_VERDICTS)[number];
  problems: string[];
}

export function seamAnswerOf(value: unknown): SeamAnswer {
  const v = value as SeamAnswer;
  return { verdict: v.verdict, problems: [...v.problems] };
}

/** Провал стыка - `fail` или названная проблема; `unsure` без проблем - не провал (как у сверки). */
export function seamFailed(answer: SeamAnswer): boolean {
  return answer.verdict === 'fail' || answer.problems.some((p) => p.trim() !== '');
}

export function seamProblems(answer: SeamAnswer): string[] {
  return answer.problems
    .map((p) => p.trim())
    .filter((p) => p !== '')
    .slice(0, SEAM_PROBLEMS_MAX)
    .map((p) => p.slice(0, SEAM_PROBLEM_MAX_CHARS));
}

export interface SeamChunk {
  firstBlock: number;
  lastBlock: number;
  blocks: unknown;
}

export interface SeamInput {
  sourceLanguage: Language;
  targetLanguage: Language;
  sourceBefore: string;
  sourceAfter: string;
  translatedBefore: string;
  translatedAfter: string;
}

/**
 * Окно стыка `seam` (между кусками `seam - 1` и `seam`): последние переводимые блоки прошлого куска
 * и первые следующего, исходник и перевод по номерам блоков. Одно правило на шаг и оценку.
 */
export function seamInputOf(
  layout: Pick<ChapterLayout, 'blocks'>,
  previous: SeamChunk,
  next: SeamChunk,
  languages: { sourceLanguage: Language; targetLanguage: Language },
): SeamInput {
  const before = chunkBlocks(layout, previous).slice(-SEAM_WINDOW_BLOCKS);
  const after = chunkBlocks(layout, next).slice(0, SEAM_WINDOW_BLOCKS);
  const translated = (chunk: SeamChunk) =>
    (Array.isArray(chunk.blocks) ? chunk.blocks : []) as TranslatedBlock[];
  const left = pieceTexts(before, translated(previous));
  const right = pieceTexts(after, translated(next));
  return {
    ...languages,
    sourceBefore: left.sourceText,
    sourceAfter: right.sourceText,
    translatedBefore: left.translatedText,
    translatedAfter: right.translatedText,
  };
}

export function seamMessages(input: SeamInput): LlmChatMessage[] {
  const from = LANGUAGE_NAMES[input.sourceLanguage];
  const to = LANGUAGE_NAMES[input.targetLanguage];
  return [
    {
      role: 'system',
      content:
        `You check a joint in a literary translation from ${from} into ${to}: the translation ` +
        'was made in pieces, and here are the blocks just before and just after the joint, the ' +
        'source and the translation. ' +
        FENCE_RULE +
        ' Read across the joint: the translation must read on without a ' +
        'break, with nothing of the source lost and nothing repeated at the joint. verdict: pass - ' +
        'it reads on and nothing is lost or repeated; fail - something is lost, repeated or broken ' +
        'at the joint; unsure - you cannot tell. problems: short notes, each naming what is wrong ' +
        'at the joint; an empty list on pass.',
    },
    {
      role: 'user',
      content:
        fenced('SOURCE_BEFORE', input.sourceBefore) +
        '\n\n' +
        fenced('SOURCE_AFTER', input.sourceAfter) +
        '\n\n' +
        fenced('TRANSLATION_BEFORE', input.translatedBefore) +
        '\n\n' +
        fenced('TRANSLATION_AFTER', input.translatedAfter),
    },
  ];
}

export const seamRequest = (input: SeamInput) =>
  shapedRequest('check_seam', SEAM_SHAPE, seamMessages(input));

/** Находки стыков моделью среди находок главы: по ним - какой стык ещё не проверен. */
export function seamFindingsOf(findings: unknown): SeamFinding[] {
  return (Array.isArray(findings) ? findings : []).filter(
    (f): f is SeamFinding =>
      typeof f === 'object' &&
      f !== null &&
      SEAM_CODES.has((f as SeamFinding).code) &&
      typeof (f as SeamFinding).seam === 'number',
  );
}

/** Первый стык главы из `chunks` кусков без ответа модели; все проверены - `null`. */
export function nextSeam(chunks: number, findings: unknown): number | null {
  const checked = new Set(seamFindingsOf(findings).map((f) => f.seam));
  for (let seam = 1; seam < chunks; seam++) if (!checked.has(seam)) return seam;
  return null;
}
