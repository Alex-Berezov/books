import { PrismaClient } from '@prisma/client';
import { RUN_CHAPTER_CHUNKS_MAX } from '../run/translation-run.constants';
import { chapterFingerprint } from '../source-fingerprint';
import { AssemblyChunk } from './chapter-assembly';

/**
 * Вход сборки главы языка (`F05-6`): текст главы исходника и куски по порядку - один на сборку
 * (6a) и на запись черновика (6b), чтобы глава собиралась из тех же полей кусков, что при сборке.
 * `null` - главы нет, кусков нет или главу правили после нарезки (отпечаток не сошёлся).
 */
export async function chapterAssemblyInput(
  db: Pick<PrismaClient, 'chapter' | 'translationChunk'>,
  sourceVersionId: string,
  runLanguageId: string,
  number: number,
): Promise<{ content: string; chunks: AssemblyChunk[] } | null> {
  const [chapter, chunks] = await Promise.all([
    db.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId: sourceVersionId, number } },
      select: { content: true },
    }),
    db.translationChunk.findMany({
      where: { runLanguageId, chapterNumber: number },
      orderBy: { chunkIndex: 'asc' },
      select: {
        chunkIndex: true,
        firstBlock: true,
        lastBlock: true,
        status: true,
        blocks: true,
        flagReason: true,
        chapterFingerprint: true,
      },
      take: RUN_CHAPTER_CHUNKS_MAX,
    }),
  ]);
  if (
    !chapter ||
    chunks.length === 0 ||
    chapterFingerprint(chapter.content) !== chunks[0].chapterFingerprint
  ) {
    return null;
  }
  return { content: chapter.content, chunks };
}
