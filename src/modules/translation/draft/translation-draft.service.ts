import { Injectable, Logger } from '@nestjs/common';
import { Language, Prisma, PublicationStatus, TranslationChapter } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { BookVersionService } from '../../book-version/book-version.service';
import { CreateBookVersionDto } from '../../book-version/dto/create-book-version.dto';
import {
  CREATE_FROM_RUN_REJECTIONS,
  CreateFromRunRejectedError,
  CreateFromRunRejectionCode,
} from '../../book-version/create-from-run';
import { BOOK_LANGUAGE_TX_OPTIONS, lockBookLanguages } from '../../book-version/book-language-lock';
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
import { isBlank } from '../chapter-blocks';
import { TARGET_VERSION_SELECT, targetVersionReason } from '../target-version-text';
import { TargetVersionReason } from '../translation-source';
import { lockVersionRow } from '../version-lock';
import { ChapterFlagCode, DRAFT_FLAG_REASONS } from './draft.constants';

/** Запуск уже стоит на `DOSSIER_STALE`: версия откатывается, шаг уходит в `pauseStale`. */
class DraftAfterStaleError extends Error {}

/** Черновик языка уже создавался и удалён: второй не создаётся, версия откатывается. */
class DraftDeletedError extends Error {}

/** Название или описание исходника правили после ответа `metadata`: версия откатывается. */
class MetadataFieldsChangedError extends Error {}

/** Версию, куда пишутся главы, опубликовали посреди запуска: вставка главы откатывается. */
class VersionPublishedError extends Error {}

/**
 * Исход записи главы: `draft_deleted` - версию удалили, `version_published` - опубликовали
 * (решение арбитра `F05 | F05-19`, круг 1 п.1); иначе глава записана, пропущена или помечена.
 */
export type ChapterWrite = 'draft_deleted' | 'version_published' | void;

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

/**
 * Итог шага черновика. `retry` - версия на языке появилась или пропала между чтением и замком:
 * следующий шаг перечитает и создаст или привяжет. `rejected` с причиной версии (D9) - версию
 * на языке опубликовали или в неё записали текст, пока язык ждал (решение арбитра `F05 | F05-19`, Ж).
 */
export type DraftCreation =
  | { kind: 'created'; versionId: string }
  | { kind: 'retry' }
  | { kind: 'deleted' }
  | { kind: 'fields_changed' }
  | {
      kind: 'rejected';
      code: CreateFromRunRejectionCode | TargetVersionReason;
      text: string | null;
    };

/** Собранная к записи глава: текст и переведённое название. */
interface AssembledChapter {
  content: string;
  title: string;
  titleMissing: boolean;
}

/**
 * Черновик версии языка запуска (`F05-6`, 6b; Р6, Р11, Р12, Р22). Версии на языке нет - её создаёт
 * тот же метод, что у редактора (`BookVersionService.create`, режим «от запуска»; замок языка -
 * внутри метода). Есть черновик без текста глав - перевод пишется в него (слово владельца D9,
 * решения арбитра `F05 | F05-19`): привязка под тем же замком языка, поля версии не трогаются.
 * Главы пишет тот же путь, что у ручных (`ChapterService.createLocked` / `rewriteLocked`, замок
 * прав и пометка свежести).
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
   * Черновик языка: версии на языке нет - создаётся (`createDraft`), есть - привязывается
   * (`attachDraft`). `null` - исходной версии нет или запуск встал на устаревшем исходнике.
   */
  async openDraft(
    lang: DraftLanguage,
    metadata: MetadataResult,
    sourceHash?: string,
  ): Promise<DraftCreation | null> {
    const source = await this.prisma.bookVersion.findUnique({
      where: { id: lang.run.bookVersionId },
      select: { bookId: true },
    });
    if (!source) return null;
    const existing = await this.prisma.bookVersion.findUnique({
      where: { bookId_language: { bookId: source.bookId, language: lang.language } },
      select: { id: true },
    });
    if (existing) return this.attachDraft(lang, source.bookId, existing.id);
    const created = await this.createDraft(lang, metadata, sourceHash);
    // Версию создали между чтением и созданием (редактор или прошлый исполнитель этого языка):
    // следующий шаг её привяжет или увидит свою ссылку.
    if (
      created?.kind === 'rejected' &&
      created.code === CREATE_FROM_RUN_REJECTIONS.VERSION_EXISTS
    ) {
      return { kind: 'retry' };
    }
    return created;
  }

  /**
   * Привязка существующей версии к языку запуска (D9). Порядок замков тот же, что у создания:
   * язык книги, строка операции, затем строка версии - её `FOR NO KEY UPDATE` ждут ручная запись
   * главы и публикация, поэтому статус и текст под замком сверяются с их итогом (решение арбитра
   * `F05 | F05-19`, Ж). Поля версии не трогаются, снимок `sourceHash` не сверяется (В). Ссылку
   * прошлого запуска на эту версию снимаем той же транзакцией: она `@unique`, а прошлый запуск
   * уже завершён - иначе язык не стартовал бы (Б, Р23).
   */
  private async attachDraft(
    lang: DraftLanguage,
    bookId: string,
    versionId: string,
  ): Promise<DraftCreation | null> {
    try {
      return await this.prisma.$transaction(async (tx): Promise<DraftCreation> => {
        await lockBookLanguages(tx, bookId, [lang.language]);
        const own = await tx.translationRunLanguage.findUnique({
          where: { id: lang.id },
          select: { bookVersionId: true },
        });
        // Повтор шага после потерянной аренды: версию уже привязал или создал прошлый исполнитель -
        // до сверки свежести, как и раньше: язык с живым черновиком идёт к главам, а не на паузу.
        if (own?.bookVersionId === versionId) return { kind: 'created', versionId };
        await this.assertRunFresh(tx, lang);
        await lockVersionRow(tx, versionId);
        const version = await tx.bookVersion.findUnique({
          where: { id: versionId },
          select: { ...TARGET_VERSION_SELECT, bookId: true },
        });
        if (!version || version.bookId !== bookId || version.language !== lang.language) {
          return { kind: 'retry' };
        }
        // Без отбора по анкете: чужой текст не перезаписывается, даже если язык убрали из неё.
        const blocked = await targetVersionReason(tx, version);
        if (blocked) return { kind: 'rejected', code: blocked, text: null };
        await tx.translationRunLanguage.updateMany({
          where: { bookVersionId: versionId, id: { not: lang.id } },
          data: { bookVersionId: null },
        });
        await this.linkLanguage(tx, lang, versionId);
        return { kind: 'created', versionId };
      }, BOOK_LANGUAGE_TX_OPTIONS);
    } catch (error) {
      return this.draftFailure(error);
    }
  }

  /**
   * Запуск уже встал на устаревшем исходнике (тупик Р13, `pauseStale` другого языка) или исходник
   * правили между последней сверкой шага и замком (Н6) - `DraftAfterStaleError`, черновика нет:
   * иначе он остался бы пустым навсегда (решение арбитра `F05 | F05-6`). Замок строки операции -
   * после замка языка книги, тот же порядок, что у паузы.
   */
  private async assertRunFresh(tx: Prisma.TransactionClient, lang: DraftLanguage): Promise<void> {
    await lockOperationRow(tx, lang.run.operationId);
    const operation = await tx.llmOperation.findUnique({
      where: { id: lang.run.operationId },
      select: { status: true, pauseReason: true },
    });
    if (operation?.status === 'paused' && operation.pauseReason === 'DOSSIER_STALE') {
      throw new DraftAfterStaleError();
    }
    // Главы - отпечатком исходника (иначе пауза `DOSSIER_STALE`). Читается через `tx` после замка
    // операции; строка версии исходника не запирается: правка, закоммиченная после этого чтения, -
    // то же, что правка после создания черновика, её сверка не ловит (решение арбитра
    // `F05 | F05-6`, 23.10.2026, «сверка только до create»).
    if ((await sourceFingerprint(tx, lang.run.bookVersionId)) !== lang.run.dossierFingerprint) {
      throw new DraftAfterStaleError();
    }
  }

  /**
   * Ссылка - только языку в работе и ещё без черновика: шаг мог прочитать язык до того, как прошлый
   * исполнитель создал черновик, а редактор его удалил.
   */
  private async linkLanguage(
    tx: Prisma.TransactionClient,
    lang: DraftLanguage,
    versionId: string,
  ): Promise<void> {
    const linked = await tx.translationRunLanguage.updateMany({
      where: {
        id: lang.id,
        status: { in: [...RUN_LANGUAGE_UNFINISHED] },
        draftCreatedAt: null,
      },
      data: { bookVersionId: versionId, draftCreatedAt: new Date() },
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
  }

  /** Исключение транзакции черновика - исход шага; чужое пробрасывается. */
  private draftFailure(error: unknown): DraftCreation | null {
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
          await this.assertRunFresh(tx, lang);
          // Название, описание и автор - снимком ответа `metadata`: отпечаток исходника их не видит.
          if (sourceHash !== undefined) {
            const fields = await tx.bookVersion.findUnique({
              where: { id: lang.run.bookVersionId },
              select: { title: true, description: true, author: true },
            });
            if (!fields || metadataSourceHash(fields) !== sourceHash) {
              throw new MetadataFieldsChangedError();
            }
          }
          await this.linkLanguage(tx, lang, created.id);
        },
      });
      return { kind: 'created', versionId: version.id };
    } catch (error) {
      return this.draftFailure(error);
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
   * Глава с этим номером уже есть в черновике: с содержимым (`isBlank`) - пропуск без записи и без
   * `writtenHash` (решение арбитра, В2): чужую главу перезапись по Р9 не тронет; без содержимого
   * (заготовка редактора в привязанной версии, D9) - перевод пишется в неё (`fillEmptyChapter`).
   * Номер заняли между проверкой и записью (`P2002`) - то же правило по занявшей главе.
   * Версию опубликовали посреди запуска - `version_published`, глава не пишется (решение арбитра
   * `F05 | F05-19`, круг 1 п.1).
   */
  async writeChapter(
    lang: DraftLanguage & { bookVersionId: string },
    row: TranslationChapter,
    titles: MetadataResult['chapterTitles'],
    renewLease: () => Promise<void>,
  ): Promise<ChapterWrite> {
    const number = row.chapterNumber;
    const existing = await this.chapterAt(lang.bookVersionId, number);
    if (existing && !isBlank(existing.content)) return this.markSkipped(row, existing.id);
    const chapter = await this.assemble(lang, row, titles);
    if (!chapter) return;
    await renewLease();
    if (existing) return this.fillEmptyChapter(lang, row, existing.id, chapter);
    const { content, title, titleMissing } = chapter;
    try {
      await this.chapters.createLocked(
        lang.bookVersionId,
        { number, title, content },
        async (tx, created) => {
          // Строка версии заперта замком прав: публикация ждёт его, статус - итог.
          await this.assertStillDraft(tx, lang.bookVersionId);
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
                writtenHash: chapterFingerprint(content),
              },
              where: { status: 'assembled' },
            },
          );
        },
      );
    } catch (error) {
      if (error instanceof VersionPublishedError) return 'version_published';
      // Черновик удалили посреди записи: замок прав или вставка главы отказали по пропавшей версии.
      if (await this.draftGone(lang.bookVersionId)) return 'draft_deleted';
      if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
        throw error;
      }
      const taken = await this.chapterAt(lang.bookVersionId, number);
      if (!taken) throw error;
      this.logger.warn(`chapter ${number} of ${lang.bookVersionId} taken during the write`);
      if (isBlank(taken.content)) return this.fillEmptyChapter(lang, row, taken.id, chapter);
      await this.markSkipped(row, taken.id);
    }
  }

  private chapterAt(bookVersionId: string, number: number) {
    return this.prisma.chapter.findUnique({
      where: { bookVersionId_number: { bookVersionId, number } },
      select: { id: true, content: true },
    });
  }

  /** Версия, куда пишутся главы, - всё ещё черновик; иначе `VersionPublishedError` (откат записи). */
  private async assertStillDraft(tx: Prisma.TransactionClient, bookVersionId: string) {
    const version = await tx.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { status: true },
    });
    if (version && version.status !== PublicationStatus.draft) throw new VersionPublishedError();
  }

  /**
   * Сборка главы к записи. Отпечаток совпал, а глава не собралась - причина сборки, а не правка
   * исходника: глава `flagged`, `null`.
   */
  private async assemble(
    lang: DraftLanguage,
    row: TranslationChapter,
    titles: MetadataResult['chapterTitles'],
  ): Promise<AssembledChapter | null> {
    const number = row.chapterNumber;
    const input = await chapterAssemblyInput(this.prisma, lang.run.bookVersionId, lang.id, number);
    const assembly = input
      ? assembleTranslatedChapter(splitChapter(input.content), input.chunks)
      : null;
    if (!assembly || assembly.status !== 'assembled') {
      await this.markNotWritten(
        lang,
        row,
        assembly?.flagReason ?? DRAFT_FLAG_REASONS.SOURCE_CHANGED,
      );
      return null;
    }
    const translatedTitle = titles.find((t) => t.number === number)?.title;
    // Названия нет в ответе `metadata` (глава появилась после него): пусто и находка, глава
    // пишется; у исходника без названия находки нет (решение арбитра `F05 | F05-6`, 6c В2).
    return {
      content: assembly.content,
      title: translatedTitle ?? '',
      titleMissing: translatedTitle === undefined && input?.title.trim() !== '',
    };
  }

  /**
   * Перевод в главу привязанной версии без содержимого (решения арбитра `F05 | F05-19`, Г и Ж): под
   * замком прав и `FOR UPDATE` главы содержимое сверяется снова - редактор мог дописать его после
   * чтения, тогда пропуск. Версию опубликовали - `version_published` (круг 1 п.1). Заполненное
   * название главы остаётся, пустое получает переведённое. Главу удалили - строка остаётся
   * собранной, следующий шаг создаст главу заново.
   */
  private async fillEmptyChapter(
    lang: DraftLanguage & { bookVersionId: string },
    row: TranslationChapter,
    chapterId: string,
    chapter: AssembledChapter,
  ): Promise<ChapterWrite> {
    let outcome: 'written' | 'skipped' | 'gone' | 'version_published';
    try {
      outcome = await this.chapters.rewriteLocked(lang.bookVersionId, async (tx, writer) => {
        if ((await writer.versionStatus()) !== PublicationStatus.draft) return 'version_published';
        const locked = await writer.lockChapter(chapterId);
        if (!locked) return 'gone';
        if (!isBlank(locked.content)) return 'skipped';
        // Название - до текста: `write` пересчитывает хеш прав версии по итогу главы, а название
        // в него входит (LEGACY-030, D3).
        if (chapter.title !== '') await writer.fillEmptyTitle(chapterId, chapter.title);
        await writer.write({
          id: chapterId,
          number: row.chapterNumber,
          title: chapter.title,
          content: chapter.content,
        });
        await addChapterFindings(
          tx,
          lang.id,
          row,
          // Название редактора остаётся (Г): без перевода названия глава не безымянна.
          chapter.titleMissing && locked.title.trim() === ''
            ? [{ code: DRAFT_FLAG_REASONS.TITLE_MISSING }]
            : [],
          {
            data: {
              status: 'written',
              chapterId,
              writtenHash: chapterFingerprint(chapter.content),
            },
            where: { status: 'assembled' },
          },
        );
        return 'written';
      });
    } catch (error) {
      if (await this.draftGone(lang.bookVersionId)) return 'draft_deleted';
      throw error;
    }
    if (outcome === 'version_published') return 'version_published';
    if (outcome === 'skipped') await this.markSkipped(row, chapterId);
  }

  private async draftGone(bookVersionId: string): Promise<boolean> {
    const draft = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { id: true },
    });
    return !draft;
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
