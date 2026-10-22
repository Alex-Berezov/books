import { Language } from '@prisma/client';
import { richHtmlText } from '../../../shared/sanitize/rich-html-text';
import { ChapterLayout } from '../chapter-blocks';
import { ChapterChunk } from '../chunking/chapter-chunks';
import { TRANSLATE_TAIL_MAX_CHARS } from './translate.constants';
import { TranslatedBlock } from './translate.format';
import { TranslateContext, TranslateInput } from './translate.prompts';

/**
 * Вход перевода куска (`tech.md` §2, «Контекст на вызов»): контекст не растёт с книгой - из досье
 * только голос, рассказчик, обстановка и главные персонажи, из глоссария - записи, встреченные
 * в куске и соседних, и записи главных персонажей.
 */

interface DossierCharacter {
  key: string;
  name: string;
  variants: string[];
  role: string;
}

interface DossierLike {
  characters?: DossierCharacter[];
  narration?: unknown;
  setting?: unknown;
  voice?: unknown;
  chapters?: Array<{ number: number; summary: string }>;
}

interface GlossaryLike {
  entries?: Array<{ key: string; source: string }>;
  address?: Array<{ from: string; to: string }>;
  phrases?: Array<{ source: string }>;
}

export function translateContext(dossier: unknown): TranslateContext {
  const d = (dossier ?? {}) as DossierLike;
  return {
    voice: d.voice ?? null,
    narration: d.narration ?? null,
    setting: d.setting ?? null,
    mainCharacters: (d.characters ?? []).filter((c) => c.role === 'main'),
  };
}

export function chapterSummary(dossier: unknown, chapterNumber: number): string | null {
  const d = (dossier ?? {}) as DossierLike;
  return d.chapters?.find((c) => c.number === chapterNumber)?.summary ?? null;
}

/** Переводимые блоки куска с номерами - то, что уходит модели. */
export function chunkBlocks(
  layout: Pick<ChapterLayout, 'blocks'>,
  chunk: ChapterChunk,
): Array<{ n: number; html: string }> {
  return layout.blocks
    .filter((b) => b.translatable && b.n >= chunk.firstBlock && b.n <= chunk.lastBlock)
    .map((b) => ({ n: b.n, html: b.html }));
}

function chunkText(layout: Pick<ChapterLayout, 'blocks'>, chunk: ChapterChunk | undefined): string {
  if (!chunk) return '';
  return chunkBlocks(layout, chunk)
    .map((b) => richHtmlText(b.html))
    .join(' ');
}

/**
 * Записи глоссария куска: встреченные в куске и соседних (по написанию и вариантам имени) плюс
 * главные; обращения - между персонажами из этих записей.
 */
export function glossaryFor(
  glossary: unknown,
  dossier: unknown,
  text: string,
): TranslateInput['glossary'] {
  const g = (glossary ?? {}) as GlossaryLike;
  const characters = ((dossier ?? {}) as DossierLike).characters ?? [];
  const lower = text.toLowerCase();
  const seen = (word: string) => word.trim() !== '' && lower.includes(word.toLowerCase());
  const main = new Set(characters.filter((c) => c.role === 'main').map((c) => c.key));
  const variants = new Map(characters.map((c) => [c.key, [c.name, ...c.variants]]));
  const entries = (g.entries ?? []).filter(
    (e) => main.has(e.key) || seen(e.source) || (variants.get(e.key) ?? []).some(seen),
  );
  const keys = new Set(entries.map((e) => e.key));
  return {
    entries,
    address: (g.address ?? []).filter((a) => keys.has(a.from) && keys.has(a.to)),
    phrases: (g.phrases ?? []).filter((p) => seen(p.source)),
  };
}

/** Конец перевода предыдущего куска: последние блоки, всего не длиннее `TRANSLATE_TAIL_MAX_CHARS`. */
export function tailOf(blocks: readonly TranslatedBlock[]): string | null {
  const parts: string[] = [];
  let size = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const text = blocks[i].text;
    if (parts.length > 0 && size + text.length > TRANSLATE_TAIL_MAX_CHARS) break;
    parts.unshift(
      text.length > TRANSLATE_TAIL_MAX_CHARS ? text.slice(-TRANSLATE_TAIL_MAX_CHARS) : text,
    );
    size += text.length;
  }
  return parts.length > 0 ? parts.join('\n') : null;
}

/**
 * Блоки, с которых берётся хвост: последний непустой переведённый кусок. Кусок из одних `hr` и
 * картинок пишется пустым и хвоста не даёт - иначе модель теряла бы связь с текстом до него.
 */
export function lastTranslated(
  done: ReadonlyArray<readonly TranslatedBlock[]>,
): readonly TranslatedBlock[] | undefined {
  for (let i = done.length - 1; i >= 0; i--) if (done[i].length > 0) return done[i];
  return undefined;
}

export function pieceInput(input: {
  layout: Pick<ChapterLayout, 'blocks'>;
  chunks: readonly ChapterChunk[];
  index: number;
  dossier: unknown;
  glossary: unknown;
  sourceLanguage: Language;
  targetLanguage: Language;
  chapterNumber: number;
  previousTail: string | null;
}): TranslateInput {
  const { layout, chunks, index } = input;
  const text = [chunks[index - 1], chunks[index], chunks[index + 1]]
    .map((c) => chunkText(layout, c))
    .join(' ');
  return {
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    context: translateContext(input.dossier),
    glossary: glossaryFor(input.glossary, input.dossier, text),
    chapterNumber: input.chapterNumber,
    chapterSummary: chapterSummary(input.dossier, input.chapterNumber),
    previousTail: input.previousTail,
    blocks: chunkBlocks(layout, chunks[index]),
  };
}
