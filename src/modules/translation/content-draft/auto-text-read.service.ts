import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { llmTaskConflict } from '../../llm-worker/llm-worker.errors';
import { AutoTextReadDto } from '../dto/auto-text-read-response.dto';
import { lockVersionRow } from '../version-lock';
import {
  AUTO_TEXT_MARKS_SELECT,
  AutoTextKind,
  autoTextRead,
} from '../../book-version/auto-text-marks';
import {
  AUTO_TEXT_CHANGED,
  AUTO_TEXT_NONE,
  AUTO_TEXT_RUN_BUILDING,
  AUTO_TEXT_RUN_KINDS,
} from './content-draft.constants';

const MARKS_SELECT = {
  ...AUTO_TEXT_MARKS_SELECT,
  summaryReadById: true,
  analysisReadById: true,
} as const;

/**
 * Отметка редактора «прочитано» на вкладках Summary и Analysis (`T184`; решение арбитра
 * 12.11.2026 `T184 | LEGACY-493 | LEGACY-495`): ставит и снимает только `admin`, как весь ход.
 * Без действующей отметки публикация версии с автотекстом отказывает (`AUTO_TEXT_NOT_READ`).
 */
@Injectable()
export class AutoTextReadService {
  constructor(private readonly prisma: PrismaService) {}

  state(bookVersionId: string, kind: AutoTextKind): Promise<AutoTextReadDto> {
    return this.read(this.prisma, bookVersionId, kind);
  }

  /**
   * 409 `AUTO_TEXT_RUN_BUILDING` - ход вида строится; 409 `AUTO_TEXT_NONE` - читать нечего;
   * 409 `AUTO_TEXT_CHANGED` - `seenAutoTextAt` не последний текст модели (с текущим состоянием).
   */
  mark(
    bookVersionId: string,
    kind: AutoTextKind,
    userId: string,
    seenAutoTextAt: string,
  ): Promise<AutoTextReadDto> {
    return this.prisma.$transaction(async (tx) => {
      // Замок строки версии - в одну очередь с записью хода (`lockVersionRow`) и публикацией.
      await lockVersionRow(tx, bookVersionId);
      const before = await this.read(tx, bookVersionId, kind);
      const building = await tx.contentDraft.findFirst({
        where: { bookVersionId, kind: AUTO_TEXT_RUN_KINDS[kind], status: 'building' },
        select: { id: true },
      });
      if (building) {
        throw llmTaskConflict(AUTO_TEXT_RUN_BUILDING, 'The run is still writing this text');
      }
      if (!before.autoTextAt) {
        throw llmTaskConflict(AUTO_TEXT_NONE, 'No model text has been written here');
      }
      if (before.autoTextAt.getTime() !== new Date(seenAutoTextAt).getTime()) {
        throw llmTaskConflict(
          AUTO_TEXT_CHANGED,
          'New model text was written after the tab was shown: read it first',
          { current: before },
        );
      }
      // Не раньше последнего вклада модели: часы другого экземпляра приложения могли уйти вперёд,
      // и отметка, взятая по своим часам, не сняла бы требование вовсе. Порядок держит замок строки.
      const now = new Date(Math.max(Date.now(), before.autoTextAt.getTime()));
      await tx.bookVersion.update({
        where: { id: bookVersionId },
        data:
          kind === 'summary'
            ? { summaryReadAt: now, summaryReadById: userId }
            : { analysisReadAt: now, analysisReadById: userId },
      });
      return this.read(tx, bookVersionId, kind);
    });
  }

  /** Снять отметку: публикация снова потребует прочитать текст. */
  async unmark(bookVersionId: string, kind: AutoTextKind): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockVersionRow(tx, bookVersionId);
      await this.read(tx, bookVersionId, kind);
      await tx.bookVersion.update({
        where: { id: bookVersionId },
        data:
          kind === 'summary'
            ? { summaryReadAt: null, summaryReadById: null }
            : { analysisReadAt: null, analysisReadById: null },
      });
    });
  }

  private async read(
    client: Pick<PrismaService, 'bookVersion'>,
    bookVersionId: string,
    kind: AutoTextKind,
  ): Promise<AutoTextReadDto> {
    const version = await client.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: MARKS_SELECT,
    });
    if (!version) throw new NotFoundException('Book version not found');
    const [autoTextAt, readAt, readById] =
      kind === 'summary'
        ? [version.summaryAutoTextAt, version.summaryReadAt, version.summaryReadById]
        : [version.analysisAutoTextAt, version.analysisReadAt, version.analysisReadById];
    return { autoTextAt, readAt, readById, read: autoTextRead(autoTextAt, readAt) };
  }
}
