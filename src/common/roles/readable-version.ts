import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Language, Prisma } from '@prisma/client';
import type { ModeratorRolesService } from './moderator-roles.service';

/**
 * Версия для чтения редакционного материала по адресу, общему для читателя и вкладки админки
 * (анализ F03, мир книги F08): версии нет — 404; черновик не редактору — 404 с тем же текстом,
 * чтобы по ответу нельзя было отличить черновик от несуществующей версии. Пересказ сюда не входит:
 * у него свои шаги (`book-summary.service.ts`, `book-summary-sections.service.ts`).
 */
export async function readableVersion(
  client: Pick<Prisma.TransactionClient, 'bookVersion'>,
  moderatorRoles: Pick<ModeratorRolesService, 'isModerator'>,
  bookVersionId: string,
  actor: { userId: string; email: string } | undefined,
): Promise<{ language: Language; editor: boolean }> {
  const version = await client.bookVersion.findUnique({
    where: { id: bookVersionId },
    select: { status: true, language: true },
  });
  if (!version) throw new NotFoundException('BookVersion not found');
  const editor = await moderatorRoles.isModerator(actor);
  if (!editor && version.status !== 'published') {
    throw new NotFoundException('BookVersion not found');
  }
  return { language: version.language, editor };
}

/**
 * Версия для записи импортом JSON (анализ, мир книги): версии нет — 404; язык JSON не язык
 * версии — 400 с путём `language`. Отдаёт язык версии.
 */
export async function writableVersionLanguage(
  client: Pick<Prisma.TransactionClient, 'bookVersion'>,
  bookVersionId: string,
  language: Language,
): Promise<Language> {
  const version = await client.bookVersion.findUnique({
    where: { id: bookVersionId },
    select: { language: true },
  });
  if (!version) throw new NotFoundException('BookVersion not found');
  if (language !== version.language) {
    throw new BadRequestException(
      `language: JSON is "${language}", the version is "${version.language}"`,
    );
  }
  return version.language;
}
