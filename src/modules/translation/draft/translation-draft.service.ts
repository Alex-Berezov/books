import { Injectable, Logger } from '@nestjs/common';
import { Language, Prisma, TranslationChapter } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BookVersionService } from '../../book-version/book-version.service';
import { CreateBookVersionDto } from '../../book-version/dto/create-book-version.dto';
import {
  CREATE_FROM_RUN_REJECTIONS,
  CreateFromRunRejectedError,
  CreateFromRunRejectionCode,
} from '../../book-version/create-from-run';
import { ChapterService } from '../../chapter/chapter.service';
import { lockOperationRow } from '../../llm-worker/llm-task.service';
import { assembleTranslatedChapter } from '../assemble/chapter-assembly';
import { addChapterFindings } from '../assemble/chapter-findings';
import { chapterAssemblyInput } from '../assemble/chapter-input';
import { splitChapter } from '../chapter-blocks';
import { MetadataResult } from '../metadata/metadata-check';
import {
  CREATE_REJECTED_TEXT_MAX,
  RUN_LANGUAGE_UNFINISHED,
  RUN_TX_OPTIONS,
} from '../run/translation-run.constants';
import { metadataSourceHash } from '../metadata/metadata-state';
import { chapterFingerprint, sourceFingerprint } from '../source-fingerprint';
import { ChapterFlagCode, DRAFT_FLAG_REASONS } from './draft.constants';

/** Запуск уже стоит на `DOSSIER_STALE`: версия откатывается, шаг уходит в `pauseStale`. */
class DraftAfterStaleError extends Error {}

/** Черновик языка уже создавался и удалён: второй не создаётся, версия откатывается. */
class DraftDeletedError extends Error {}

/** Название или описание исходника правили после ответа `metadata`: версия откатывается. */
class MetadataFieldsChangedError extends Error {}

/** Язык запуска в объёме, нужном черновику. */
export interface DraftLanguage {
  id: string;
  language: Language;
  bookVersionId: string | null;
  run: {
    id: string;
    bookVersionId: string;
    operationId: string;
    dossierFingerprint: string | null;
  };
}

export type DraftCreation =
  | { kind: 'created'; versionId: string }
  | { kind: 'deleted' }
  | { kind: 'fields_changed' }
  | { kind: 'rejected'; code: CreateFromRunRejectionCode; text: string | null };

/**
 * Черновик версии языка запуска (`F05-6`, 6b; Р6, Р11, Р12, Р22). Версию создаёт тот же метод,
 * что у редактора (`BookVersionService.create`, режим «от запуска»), главы пишет тот же путь, что
 * у ручных (`ChapterService.createLocked`, замок прав и пометка свежести); своей транзакции
 * вокруг `create` и замка языка здесь нет - замок один, внутри метода.
 */
@Injectable()
export class TranslationDraftService {
  private readonly logger = new Logger(TranslationDraftService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly versions: BookVersionService,
    private readonly chapters: ChapterService,
  ) {}

  /**
   * Версия языка: поля - переведённые (`metadata`), копируемые с исходника и пустые по списку
   * карточки; права, категории, теги и статус `draft` ставит сам метод. `null` у исходника
   * (`authorId`, годы, оригинал) остаётся `null`. Ссылка языка на версию пишется той же
   * транзакцией, что версия: повтор шага после падения её видит и идёт к главам. `null` -
   * исходной версии нет, запуск уже встал на устаревшем исходнике или исходник правили после
   * последней сверки шага: шаг уходит в паузу. `fields_changed` - правили название или описание
   * после ответа `metadata` (`sourceHash`): этап идёт заново (решение арбитра `F05 | F05-6`, 6c В1).
   */
  async createDraft(
    lang: DraftLanguage,
    metadata: MetadataResult,
    sourceHash?: string,
  ): Promise<DraftCreation | null> {
    const source = await this.prisma.bookVersion.findUnique({
      where: { id: lang.run.bookVersionId },
      select: {
        bookId: true,
        type: true,
        isFree: true,
        coverImageUrl: true,
        referralUrl: true,
        firstPublishedYear: true,
        editionPublishedYear: true,
        originalLanguage: true,
        originalTitle: true,
        authorId: true,
      },
    });
    if (!source) return null;
    const dto: CreateBookVersionDto = {
      language: lang.language,
      title: metadata.title,
      author: metadata.author,
      description: metadata.description,
      type: source.type,
      isFree: source.isFree,
      coverImageUrl: source.coverImageUrl,
      referralUrl: source.referralUrl ?? undefined,
      firstPublishedYear: source.firstPublishedYear,
      editionPublishedYear: source.editionPublishedYear,
      originalLanguage: source.originalLanguage,
      originalTitle: source.originalTitle,
      authorId: source.authorId,
    };
    try {
      const version = await this.versions.create(source.bookId, dto, lang.language, {
        runId: lang.run.id,
        afterCreate: async (tx, created) => {
          // Запуск уже встал на устаревшем исходнике (тупик Р13, `pauseStale` другого языка):
          // черновика нет - иначе он остался бы пустым навсегда (решение арбитра `F05 | F05-6`).
          // Замок строки операции - после замка языка книги, тот же порядок, что у паузы.
          await lockOperationRow(tx, lang.run.operationId);
          const operation = await tx.llmOperation.findUnique({
            where: { id: lang.run.operationId },
            select: { status: true, pauseReason: true },
          });
          if (operation?.status === 'paused' && operation.pauseReason === 'DOSSIER_STALE') {
            throw new DraftAfterStaleError();
          }
          // Исходник правили между последней сверкой шага и замком (Н6): главы - отпечатком
          // исходника (иначе пауза `DOSSIER_STALE`), название, описание и автор - снимком ответа
          // `metadata` (отпечаток их не видит). Читается через `tx` после замка операции; строка
          // версии исходника не запирается: правка, закоммиченная после этого чтения, - то же, что
          // правка после создания черновика, её сверка не ловит (решение арбитра `F05 | F05-6`,
          // 23.10.2026, «сверка только до create»).
          if (
            (await sourceFingerprint(tx, lang.run.bookVersionId)) !== lang.run.dossierFingerprint
          ) {
            throw new DraftAfterStaleError();
          }
          if (sourceHash !== undefined) {
            const fields = await tx.bookVersion.findUnique({
              where: { id: lang.run.bookVersionId },
              select: { title: true, description: true, author: true },
            });
            if (!fields || metadataSourceHash(fields) !== sourceHash) {
              throw new MetadataFieldsChangedError();
            }
          }
          // Ссылка - только языку в работе и ещё без черновика: шаг мог прочитать язык до того,
          // как прошлый исполнитель создал черновик, а редактор его удалил.
          const linked = await tx.translationRunLanguage.updateMany({
            where: {
              id: lang.id,
              status: { in: [...RUN_LANGUAGE_UNFINISHED] },
              draftCreatedAt: null,
            },
            data: { bookVersionId: created.id, draftCreatedAt: new Date() },
          });
          if (linked.count > 0) return;
          const current = await tx.translationRunLanguage.findUnique({
            where: { id: lang.id },
            select: { status: true, draftCreatedAt: true },
          });
          // Черновик уже создавался и удалён - второй не создаётся (решение арбитра `F05 | F05-6`).
          if (current?.draftCreatedAt) throw new DraftDeletedError();
          // Язык отменили, пока версия ждала замка: черновика у отменённого языка не будет.
          throw new CreateFromRunRejectedError(
            CREATE_FROM_RUN_REJECTIONS.CREATE_REJECTED,
            'The run language is no longer in progress',
          );
        },
      });
      return { kind: 'created', versionId: version.id };
    } catch (error) {
      if (error instanceof DraftAfterStaleError) return null;
      if (error instanceof DraftDeletedError) return { kind: 'deleted' };
      if (error instanceof MetadataFieldsChangedError) return { kind: 'fields_changed' };
      if (!(error instanceof CreateFromRunRejectedError)) throw error;
      // Текст нужен только отказу предусловия; он из исключения самого сервиса (решение арбитра).
      return {
        kind: 'rejected',
        code: error.code,
        text:
          error.code === CREATE_FROM_RUN_REJECTIONS.CREATE_REJECTED
            ? error.message.slice(0, CREATE_REJECTED_TEXT_MAX)
            : null,
      };
    }
  }

  /** Следующая глава к записи: собрана, но не записана; по порядку номеров исходника. */
  nextToWrite(languageId: string): Promise<TranslationChapter | null> {
    return this.prisma.translationChapter.findFirst({
      where: { runLanguageId: languageId, status: 'assembled' },
      orderBy: { chapterNumber: 'asc' },
    });
  }

  /**
   * Запись одной главы (шаг 7). Сверка отпечатка главы исходника с её кусками (`chapterAssemblyInput`,
   * общий вход со сборкой 6a): не совпал - глава `flagged` `SOURCE_CHANGED` и не пишется, язык
   * идёт дальше (решение арбитра `F05 | F05-6`).
   * Глава с этим номером уже есть в черновике - пропуск без записи и без `writtenHash`
   * (решение арбитра, В2): чужую главу перезапись по Р9 не тронет. Номер заняли между проверкой
   * и записью - тот же пропуск (`P2002`).
   */
  async writeChapter(
    lang: DraftLanguage & { bookVersionId: string },
    row: TranslationChapter,
    titles: MetadataResult['chapterTitles'],
    renewLease: () => Promise<void>,
  ): Promise<'draft_deleted' | void> {
    const number = row.chapterNumber;
    const existing = await this.prisma.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId: lang.bookVersionId, number } },
      select: { id: true },
    });
    if (existing) return this.markSkipped(row, existing.id);
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    const assembly = input
      ? assembleTranslatedChapter(splitChapter(input.content), input.chunks)
      : null;
    // Отпечаток совпал, а глава не собралась - причина сборки, а не правка исходника.
    if (!assembly || assembly.status !== 'assembled') {
      await this.markNotWritten(
        lang,
        row,
        assembly?.flagReason ?? DRAFT_FLAG_REASONS.SOURCE_CHANGED,
      );
      return;
    }
    const translatedTitle = titles.find((t) => t.number === number)?.title;
    // Названия нет в ответе `metadata` (глава появилась после него): пусто и находка, глава
    // пишется; у исходника без названия находки нет (решение арбитра `F05 | F05-6`, 6c В2).
    const titleMissing = translatedTitle === undefined && input?.title.trim() !== '';
    const title = translatedTitle ?? '';
    await renewLease();
    try {
      await this.chapters.createLocked(
        lang.bookVersionId,
        { number, title, content: assembly.content },
        async (tx, created) => {
          await addChapterFindings(
            tx,
            lang.id,
            row,
            titleMissing ? [{ code: DRAFT_FLAG_REASONS.TITLE_MISSING }] : [],
            {
              data: {
                status: 'written',
                chapterId: created.id,
                // Та же функция, которой Р9 сверит текст главы с записанным (`F05-7v`).
                writtenHash: chapterFingerprint(assembly.content),
              },
              where: { status: 'assembled' },
            },
          );
        },
      );
    } catch (error) {
      const draft = await this.prisma.bookVersion.findUnique({
        where: { id: lang.bookVersionId },
        select: { id: true },
      });
      // Черновик удалили посреди записи: замок прав или вставка главы отказали по пропавшей версии.
      if (!draft) return 'draft_deleted';
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const taken = await this.prisma.chapter.findUnique({
        where: { bookVersionId_number: { bookVersionId: lang.bookVersionId, number } },
        select: { id: true },
      });
      if (!taken) throw error;
      this.logger.warn(`chapter ${number} of ${lang.bookVersionId} taken during the write`);
      await this.markSkipped(row, taken.id);
    }
  }

  private async markSkipped(row: TranslationChapter, chapterId: string): Promise<void> {
    await this.prisma.translationChapter.updateMany({
      where: { id: row.id, status: 'assembled' },
      data: { status: 'written', chapterId, writtenHash: null },
    });
  }

  /**
   * Глава не пишется (`SOURCE_CHANGED` или причина сборки): `flagReason` - то, почему её нет
   * в черновике, прежний флаг сборки остаётся в находках; счётчик - один раз на главу. Правило
   * флага - общее (`addChapterFindings`, режим замены флага; решение арбитра `F05 | F05-7v`).
   */
  private async markNotWritten(
    lang: DraftLanguage,
    row: TranslationChapter,
    reason: ChapterFlagCode,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await addChapterFindings(tx, lang.id, row, [{ code: reason }], {
        data: { status: 'flagged' },
        where: { status: 'assembled' },
        overwriteFlag: true,
      });
    }, RUN_TX_OPTIONS);
  }
}
