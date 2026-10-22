import { createHash } from 'crypto';
import { Prisma } from '@prisma/client';

export interface FingerprintChapter {
  number: number;
  title: string;
  content: string;
}

/**
 * Отпечаток текста исходника (`tech.md` §2а, «Свежесть»): sha256 по главам в порядке номеров -
 * номер, название и `content`. Считается в базе: текст книги не едет в процесс ради хеша
 * (состояние досье и каждый шаг построения сверяют его заново), и в счёт идут все главы,
 * а не первая порция выборки. Пересохранение того же текста отпечаток не меняет: санитайзер
 * возвращает чистый ввод байт в байт (`sanitizeRichHtml`).
 */
export async function sourceFingerprint(
  db: Prisma.TransactionClient,
  versionId: string,
): Promise<string> {
  const rows = await db.$queryRaw<Array<{ fingerprint: string }>>`
    SELECT encode(sha256(convert_to(coalesce(
             string_agg(json_build_array(c."number", c."title", c."content")::text, E'\n'
                        ORDER BY c."number"), ''), 'UTF8')), 'hex') AS "fingerprint"
    FROM "Chapter" AS c
    WHERE c."bookVersionId" = ${versionId}`;
  return rows[0].fingerprint;
}

/** sha256 текста одной главы: глава поменялась после нарезки - куски уже не те (`F05-3`, `F05-4`). */
export function chapterFingerprint(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}
