import { PrismaClient } from '@prisma/client';
import { RUN_CHAPTER_CHUNKS_MAX } from '../run/translation-run.constants';
import { chapterFingerprint } from '../source-fingerprint';
import { AssemblyChunk } from './chapter-assembly';

/** Кусок на входе сборки: поля сборки и модель, фактически его переведшая (правило семейств). */
export type InputChunk = AssemblyChunk & { model: string | null };

/**
 * Куски нарезаны с этого текста главы: они есть, и отпечаток главы совпал с отпечатком нарезки.
 * Одно правило на вход сборки главы и на итоговую проверку кодом по всему языку.
 */
export function chunksOfChapter(
  content: string,
  chunks: ReadonlyArray<{ chapterFingerprint: string }>,
): boolean {
  return chunks.length > 0 && chapterFingerprint(content) === chunks[0].chapterFingerprint;
}

/** Поля куска на входе сборки - одна выборка на главу и на весь язык (итоговая проверка кодом). */
export const ASSEMBLY_CHUNK_SELECT = {
  chunkIndex: true,
  firstBlock: true,
  lastBlock: true,
  status: true,
  blocks: true,
  flagReason: true,
  chapterFingerprint: true,
  model: true,
} as const;

/**
 * Вход сборки главы языка (`F05-6`): текст и название главы исходника и куски по порядку - один
 * на сборку (6a), стыки и итоговую проверку (6c) и запись черновика (6b), чтобы глава собиралась
 * из тех же полей кусков, что при сборке. `null` - главы нет, кусков нет или главу правили после
 * нарезки (отпечаток не сошёлся).
 */
export async function chapterAssemblyInput(
  db: Pick<PrismaClient, 'chapter' | 'translationChunk'>,
  sourceVersionId: string,
  runLanguageId: string,
  number: number,
): Promise<{ content: string; title: string; chunks: InputChunk[] } | null> {
  const [chapter, chunks] = await Promise.all([
    db.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId: sourceVersionId, number } },
      select: { content: true, title: true },
    }),
    db.translationChunk.findMany({
      where: { runLanguageId, chapterNumber: number },
      orderBy: { chunkIndex: 'asc' },
      select: ASSEMBLY_CHUNK_SELECT,
      take: RUN_CHAPTER_CHUNKS_MAX,
    }),
  ]);
  if (!chapter || !chunksOfChapter(chapter.content, chunks)) return null;
  return { content: chapter.content, title: chapter.title, chunks };
}
