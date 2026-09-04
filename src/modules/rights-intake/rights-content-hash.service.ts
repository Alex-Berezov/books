import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
  stableStringify,
  sha256Hex,
} from './rights-content-hash.util';
import {
  RightsContentHashComputationDto,
  RightsContentHashCheckDto,
} from './dto/rights-content-hash.dto';

type Trigger =
  | 'INITIAL_VERSION_SNAPSHOT'
  | 'BOOK_VERSION_UPDATED'
  | 'CHAPTER_CREATED'
  | 'CHAPTER_UPDATED'
  | 'CHAPTER_DELETED'
  | 'AUDIO_CHAPTER_CREATED'
  | 'AUDIO_CHAPTER_UPDATED'
  | 'AUDIO_CHAPTER_DELETED'
  | 'AUDIO_CHAPTER_REORDERED'
  | 'RIGHTS_SNAPSHOT_CHANGED'
  | 'SOURCE_EDITION_CHANGED'
  | 'REVIEW_IMPORT_CHANGED'
  | 'VERSION_CONTRIBUTOR_CHANGED'
  | 'PROFILE_CONTRIBUTOR_CHANGED'
  | 'CONTRIBUTOR_PERSON_CHANGED'
  | 'MANUAL_HASH_CHECK';

const TRIGGER_MESSAGES: Record<Trigger, string> = {
  INITIAL_VERSION_SNAPSHOT: 'Начальный слепок прав при создании версии',
  BOOK_VERSION_UPDATED: 'Изменены метаданные версии книги',
  CHAPTER_CREATED: 'Создана новая глава',
  CHAPTER_UPDATED: 'Изменена глава',
  CHAPTER_DELETED: 'Удалена глава',
  AUDIO_CHAPTER_CREATED: 'Создана новая аудио-глава',
  AUDIO_CHAPTER_UPDATED: 'Изменена аудио-глава',
  AUDIO_CHAPTER_DELETED: 'Удалена аудио-глава',
  AUDIO_CHAPTER_REORDERED: 'Изменён порядок аудио-глав',
  RIGHTS_SNAPSHOT_CHANGED: 'Изменён слепок прав',
  SOURCE_EDITION_CHANGED: 'Изменены данные исходного издания',
  REVIEW_IMPORT_CHANGED: 'Изменён импорт проверки прав',
  VERSION_CONTRIBUTOR_CHANGED: 'Изменён состав участников версии',
  PROFILE_CONTRIBUTOR_CHANGED: 'Изменён состав участников профиля прав',
  CONTRIBUTOR_PERSON_CHANGED: 'Изменены правовые данные участника',
  MANUAL_HASH_CHECK: 'Ручная проверка хеша контента',
};

/**
 * WP-8.1: три триггера участников — новые значения enum'а `RightsContentChangeTrigger`,
 * а значение enum'а PostgreSQL требует отдельной, более ранней миграции (§0.2 плана).
 * WP-8 миграции не имеет, поэтому в колонку `trigger` пишется существующее значение
 * `RIGHTS_SNAPSHOT_CHANGED` — участники и есть часть слепка прав, — а точная причина
 * сохраняется в `reasonCode` / `rightsStaleReasonCode` (свободные строки).
 * То же решение, что в WP-6.3 с типом уведомления.
 */
const TRIGGER_DB_VALUES: Partial<Record<Trigger, Trigger>> = {
  VERSION_CONTRIBUTOR_CHANGED: 'RIGHTS_SNAPSHOT_CHANGED',
  PROFILE_CONTRIBUTOR_CHANGED: 'RIGHTS_SNAPSHOT_CHANGED',
  CONTRIBUTOR_PERSON_CHANGED: 'RIGHTS_SNAPSHOT_CHANGED',
};

const triggerDbValue = (trigger: Trigger): Trigger => TRIGGER_DB_VALUES[trigger] ?? trigger;

/**
 * WP-D.1. Окно наполнения черновика. Клиренс снимается ради того, чтобы залить текст, —
 * и первая же глава этот клиренс аннулировала (шесть блокеров гейта разом). Правило не
 * отменяется, а **сужается**: расхождение хеша переснимает baseline вместо `STALE`, только если
 * выполнено всё сразу —
 *  1) триггер из списка ниже (правка самой версии, её текстовых глав или состава участников);
 *  2) версия в статусе `draft`;
 *  3) окно ещё не закрыто — версия ни разу не публиковалась (D.4).
 *
 * Аудио-главы и изменения слепка прав в окно не входят: у озвучки собственные правообладатели.
 * Компенсация за ослабление — событие `rightsContentHashEvent` пишется всегда, в той же
 * транзакции (ADR-009), поэтому подмена текста в черновике остаётся видимой в аудите.
 * Состав входа хеша не меняется, версия алгоритма остаётся прежней (ADR-010): меняется
 * только реакция на расхождение.
 */
const DRAFT_FILL_WINDOW_TRIGGERS: readonly Trigger[] = [
  'BOOK_VERSION_UPDATED',
  'CHAPTER_CREATED',
  'CHAPTER_UPDATED',
  'CHAPTER_DELETED',
  'VERSION_CONTRIBUTOR_CHANGED',
];

/** Признак пересъёмки baseline внутри окна наполнения черновика. */
export const DRAFT_FILL_WINDOW_REASON_CODE = 'DRAFT_FILL_WINDOW';

/**
 * Признак закрытия окна. Хранится событием, а не колонкой: снятие версии с публикации
 * (`unpublish` обнуляет `publishedAt`) не должно открывать окно заново, а миграций в этом
 * пакете нет.
 */
export const DRAFT_FILL_WINDOW_CLOSED_REASON_CODE = 'DRAFT_FILL_WINDOW_CLOSED';

/**
 * Признак открытия окна: пишется вместе с первым baseline версии, заведённой черновиком.
 *
 * Одного события закрытия недостаточно: его пишет только новый код `finalizeBaselineOnPublish`,
 * поэтому у версии, опубликованной до выката, такого события в базе нет — а `publishedAt`
 * обнуляется при `unpublish` и признаком «уже публиковалась» быть не может. Колонки под это
 * нет, миграций в пакете нет, поэтому окно открывается **явной отметкой**: нет отметки —
 * окно считается закрытым (fail-closed). Так все версии, заведённые до выката, и все версии,
 * созданные сразу опубликованными, остаются на прежнем строгом правиле.
 */
export const DRAFT_FILL_WINDOW_OPENED_REASON_CODE = 'DRAFT_FILL_WINDOW_OPENED';

/** Первое появление файла источника: артефакт происхождения, а не смена произведения (D.2). */
export const SOURCE_FILE_FIRST_UPLOAD_REASON_CODE = 'SOURCE_FILE_FIRST_UPLOAD';

/**
 * Границы транзакций этого сервиса. Циклов внутри них нет: пометка соседних версий вынесена
 * за транзакцию решением арбитра от 04.09.2026 (`decisions-log.md`), самая большая транзакция —
 * `markSelf` с четырьмя записями, остальные пишут по две. Запас против дефолтов Prisma
 * (5000/2000 мс) взят у соседа с тем же контуром — `contributors.service.ts`
 * (`{ timeout: 30_000, maxWait: 10_000 }`) — и снижать его незачем: он про ожидание
 * соединения в пуле, а не про объём записи.
 *
 * ⚠️ Возврат фан-аута под `inTransaction` оживит дедлок 40P01, ради снятия которого решение
 * и принималось (`LEGACY-368`).
 */
const CONTENT_HASH_TRANSACTION_TIMEOUT_MS = 30_000;
const CONTENT_HASH_TRANSACTION_MAX_WAIT_MS = 10_000;

/**
 * Порядок участников в выдаче БД не определён, а хеш обязан быть от него независим:
 * иначе клиренс «протухал» бы от любого пересчёта.
 */
const contributorSortKey = (contributor: Record<string, unknown>): string =>
  [contributor['role'], contributor['personId'], contributor['creditedName']]
    .map((part) => (typeof part === 'string' ? part : ''))
    .join('|');

/**
 * Поля персоны, от которых зависит правовое основание: год смерти решает, в public domain ли
 * перевод. Правка имени в карточке или заметок редактора клиренс не трогает.
 */
export const RIGHTS_RELEVANT_PERSON_FIELDS = [
  'canonicalName',
  'birthYear',
  'deathYear',
  'publicDomainFromYear',
  'nationalityCountryCode',
] as const;

@Injectable()
export class RightsContentHashService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * LEGACY-036: слепок контента и событие о нём обязаны лечь вместе (ADR-009). Вызывающий,
   * пришедший со своей транзакцией, остаётся в ней; вызывающий без транзакции получает свою.
   *
   * Прежде здесь везде стоял `const client = tx ?? this.prisma`, и во втором случае мутация
   * с событием шли двумя независимыми `await`: отказ между ними оставлял версию с новым
   * baseline и без записи о том, откуда он взялся.
   */
  private async inTransaction<T>(
    tx: Prisma.TransactionClient | undefined,
    work: (client: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    if (tx) return work(tx);
    return this.prisma.$transaction((innerTx) => work(innerTx), {
      timeout: CONTENT_HASH_TRANSACTION_TIMEOUT_MS,
      maxWait: CONTENT_HASH_TRANSACTION_MAX_WAIT_MS,
    });
  }

  async computeVersionHash(
    versionId: string,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashComputationDto> {
    const client = tx ?? this.prisma;
    const version = await client.bookVersion.findUnique({
      where: { id: versionId },
      include: {
        book: {
          select: {
            id: true,
            currentRightsProfileId: true,
            approvedRightsReviewId: true,
          },
        },
        chapters: {
          orderBy: { number: 'asc' },
        },
        audioChapters: {
          orderBy: { number: 'asc' },
          include: {
            media: {
              select: {
                id: true,
                key: true,
                url: true,
                contentType: true,
                size: true,
                duration: true,
                hash: true,
                isDeleted: true,
              },
            },
          },
        },
        previewMedia: {
          select: {
            id: true,
            key: true,
            url: true,
            contentType: true,
            size: true,
            duration: true,
            hash: true,
            isDeleted: true,
          },
        },
        // WP-8.1: участники версии — вход хеша, без них смена переводчика невидима для клиренса.
        contributors: {
          include: {
            person: {
              select: {
                id: true,
                canonicalName: true,
                birthYear: true,
                deathYear: true,
                publicDomainFromYear: true,
                nationalityCountryCode: true,
              },
            },
          },
        },
        rightsProfile: {
          include: {
            contributors: true,
            sourceEdition: {
              include: {
                editionRights: true,
              },
            },
            components: {
              orderBy: [{ componentType: 'asc' }, { id: 'asc' }],
            },
            territoryDecisions: {
              orderBy: { countryCode: 'asc' },
            },
            evidence: {
              orderBy: [
                { evidenceType: 'asc' },
                { authority: 'asc' },
                { title: 'asc' },
                { id: 'asc' },
              ],
            },
            actions: {
              orderBy: [{ actionType: 'asc' }, { id: 'asc' }],
            },
          },
        },
        approvedRightsReview: {
          include: {
            rightsReviewImport: true,
          },
        },
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const versionAny = version as unknown as Record<string, unknown>;

    // Build snapshot input
    const chapters = ((versionAny['chapters'] as Array<Record<string, unknown>>) || []).map(
      (ch) => ({
        number: ch['number'],
        title: ch['title'],
        content: ch['content'],
      }),
    );

    const audioChapters = (
      (versionAny['audioChapters'] as Array<Record<string, unknown>>) || []
    ).map((ac) => ({
      number: ac['number'],
      title: ac['title'],
      audioUrl: ac['audioUrl'],
      duration: ac['duration'],
      description: ac['description'] ?? null,
      transcript: ac['transcript'] ?? null,
      mediaId: ac['mediaId'] ?? null,
      media: ac['media']
        ? {
            id: (ac['media'] as Record<string, unknown>)['id'],
            key: (ac['media'] as Record<string, unknown>)['key'],
            url: (ac['media'] as Record<string, unknown>)['url'],
            contentType: (ac['media'] as Record<string, unknown>)['contentType'] ?? null,
            size: (ac['media'] as Record<string, unknown>)['size'] ?? null,
            duration: (ac['media'] as Record<string, unknown>)['duration'] ?? null,
            hash: (ac['media'] as Record<string, unknown>)['hash'] ?? null,
            isDeleted: (ac['media'] as Record<string, unknown>)['isDeleted'] ?? false,
          }
        : null,
    }));

    const rightsProfile = versionAny['rightsProfile'] as Record<string, unknown> | null;
    const approvedRightsReview = versionAny['approvedRightsReview'] as Record<
      string,
      unknown
    > | null;

    const coverMedia = await this.resolveCoverMedia(
      (versionAny['coverImageUrl'] as string | null) ?? null,
      client,
    );

    const input: Record<string, unknown> = {
      algorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
      identity: {
        bookId: versionAny['bookId'],
        versionId: versionAny['id'],
        language: versionAny['language'],
        type: versionAny['type'],
      },
      metadata: {
        title: versionAny['title'],
        author: versionAny['author'],
        authorId: versionAny['authorId'] ?? null,
        authorPageUrl: versionAny['authorPageUrl'] ?? null,
        description: versionAny['description'],
        shortDescription: versionAny['shortDescription'] ?? null,
        summaryShort: versionAny['summaryShort'] ?? null,
      },
      sourceTitleMetadata: {
        originalTitle: versionAny['originalTitle'] ?? null,
        originalLanguage: versionAny['originalLanguage'] ?? null,
        firstPublishedYear: versionAny['firstPublishedYear'] ?? null,
        editionPublishedYear: versionAny['editionPublishedYear'] ?? null,
        copyrightStatus: versionAny['copyrightStatus'] ?? null,
      },
      cover: {
        coverImageUrl: versionAny['coverImageUrl'],
        coverAlt: versionAny['coverAlt'] ?? null,
        previewMediaId: versionAny['previewMediaId'] ?? null,
        // WP-8.2: сам файл, а не только его адрес — подмена картинки по тому же URL
        // раньше оставалась невидимой для клиренса.
        coverMedia,
      },
      structuredEditorialFields: {
        alternativeTitles: versionAny['alternativeTitles'] ?? null,
        characters: versionAny['characters'] ?? null,
        quotes: versionAny['quotes'] ?? null,
        faq: versionAny['faq'] ?? null,
        themes: versionAny['themes'] ?? null,
        symbols: versionAny['symbols'] ?? null,
      },
      chapters,
      audioChapters,
      contributors: this.serializeVersionContributors(
        (versionAny['contributors'] as Array<Record<string, unknown>>) || [],
      ),
      previewMedia: versionAny['previewMedia']
        ? {
            id: (versionAny['previewMedia'] as Record<string, unknown>)['id'],
            key: (versionAny['previewMedia'] as Record<string, unknown>)['key'],
            url: (versionAny['previewMedia'] as Record<string, unknown>)['url'],
            contentType:
              (versionAny['previewMedia'] as Record<string, unknown>)['contentType'] ?? null,
            size: (versionAny['previewMedia'] as Record<string, unknown>)['size'] ?? null,
            duration: (versionAny['previewMedia'] as Record<string, unknown>)['duration'] ?? null,
            hash: (versionAny['previewMedia'] as Record<string, unknown>)['hash'] ?? null,
            isDeleted:
              (versionAny['previewMedia'] as Record<string, unknown>)['isDeleted'] ?? false,
          }
        : null,
      rightsLinks: {
        rightsProfileId: versionAny['rightsProfileId'],
        approvedRightsReviewId: versionAny['approvedRightsReviewId'],
      },
      rightsCountries: {
        rightsAllowedCountryCodes: versionAny['rightsAllowedCountryCodes'] ?? null,
        rightsBlockedCountryCodes: versionAny['rightsBlockedCountryCodes'] ?? null,
        rightsLicenseRequiredCountryCodes: versionAny['rightsLicenseRequiredCountryCodes'] ?? null,
        rightsPendingCountryCodes: versionAny['rightsPendingCountryCodes'] ?? null,
      },
      geoFields: {
        rightsGeoBlockRequired: versionAny['rightsGeoBlockRequired'] ?? false,
      },
      rightsRequiredActions: versionAny['rightsRequiredActions'] ?? null,
      rightsProfile: rightsProfile
        ? {
            overallStatus: rightsProfile['overallStatus'],
            publicationGate: rightsProfile['publicationGate'],
            confidence: rightsProfile['confidence'],
            summaryRu: rightsProfile['summaryRu'] ?? null,
            conclusionRu: rightsProfile['conclusionRu'] ?? null,
            nextReviewAt: rightsProfile['nextReviewAt']
              ? new Date(rightsProfile['nextReviewAt'] as string).toISOString()
              : null,
            sourceEdition: this.serializeSourceEdition(
              rightsProfile['sourceEdition'] as Record<string, unknown> | null,
            ),
            components: ((rightsProfile['components'] as Array<Record<string, unknown>>) || []).map(
              (c) => ({
                componentType: c['componentType'],
                titleRu: c['titleRu'],
                // WP-7.2: язык компонента правовой значим — смена языка перевода меняет
                // и переводчика, и основание для public domain.
                languageCode: c['languageCode'] ?? null,
                status: c['status'],
                requiredAction: c['requiredAction'],
                confidence: c['confidence'],
              }),
            ),
            territoryDecisions: (
              (rightsProfile['territoryDecisions'] as Array<Record<string, unknown>>) || []
            ).map((td) => ({
              countryCode: td['countryCode'],
              finalStatus: td['finalStatus'],
              accessPolicy: td['accessPolicy'],
              geoBlockRequired: td['geoBlockRequired'] ?? false,
              geoBlockScope: td['geoBlockScope'] ?? null,
            })),
            evidence: ((rightsProfile['evidence'] as Array<Record<string, unknown>>) || []).map(
              (e) => ({
                evidenceType: e['evidenceType'],
                sourceLevel: e['sourceLevel'],
                title: e['title'],
                authority: e['authority'],
                url: e['url'] ?? null,
                jurisdictionCode: e['jurisdictionCode'] ?? null,
                accessedAt: e['accessedAt']
                  ? new Date(e['accessedAt'] as string).toISOString()
                  : null,
              }),
            ),
            actions: ((rightsProfile['actions'] as Array<Record<string, unknown>>) || []).map(
              (a) => ({
                actionType: a['actionType'],
                status: a['status'],
                affectedCountryCodes: a['affectedCountryCodes'] ?? null,
                isBlocking: a['isBlocking'] ?? false,
              }),
            ),
            contributors: this.serializeProfileContributors(
              (rightsProfile['contributors'] as Array<Record<string, unknown>>) || [],
            ),
          }
        : null,
      rightsReview: approvedRightsReview
        ? {
            schemaVersion: approvedRightsReview['schemaVersion'] ?? null,
            reviewerType: approvedRightsReview['reviewerType'],
            overallStatus: approvedRightsReview['overallStatus'],
            publicationGate: approvedRightsReview['publicationGate'],
            confidence: approvedRightsReview['confidence'],
            summaryRu: approvedRightsReview['summaryRu'] ?? null,
            conclusionRu: approvedRightsReview['conclusionRu'] ?? null,
            nextReviewAt: approvedRightsReview['nextReviewAt']
              ? new Date(approvedRightsReview['nextReviewAt'] as string).toISOString()
              : null,
            rightsReviewImport: this.serializeReviewImport(
              approvedRightsReview['rightsReviewImport'] as Record<string, unknown> | null,
            ),
          }
        : null,
    };

    const serialized = stableStringify(input);
    const hash = sha256Hex(serialized);
    const algorithmVersion = RIGHTS_CONTENT_HASH_ALGORITHM_VERSION;

    return {
      versionId: versionAny['id'] as string,
      rightsProfileId: (versionAny['rightsProfileId'] as string) ?? null,
      approvedRightsReviewId: (versionAny['approvedRightsReviewId'] as string) ?? null,
      hash,
      algorithmVersion,
      calculatedAt: new Date().toISOString(),
      input,
    };
  }

  async initializeVersionBaseline(
    versionId: string,
    trigger: Trigger,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashComputationDto> {
    const computation = await this.computeVersionHash(versionId, tx);

    return this.inTransaction(tx, async (client) => {
      // WP-D.1: окно наполнения открывается только здесь и только для версии, заведённой
      // черновиком. Версия, созданная сразу опубликованной, окна не получает вовсе — иначе
      // последующий `unpublish` открыл бы его задним числом.
      const versionState = await client.bookVersion.findUnique({
        where: { id: versionId },
        select: { status: true, publishedAt: true },
      });
      const opensDraftFillWindow = versionState?.status === 'draft' && !versionState.publishedAt;

      await client.bookVersion.update({
        where: { id: versionId },
        data: {
          rightsContentHash: computation.hash,
          rightsContentHashAlgorithmVersion: computation.algorithmVersion,
          rightsContentHashInput: JSON.parse(
            JSON.stringify(computation.input),
          ) as Prisma.InputJsonValue,
          rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
          rightsRecheckRequired: false,
          rightsStaleDetectedAt: null,
          rightsStaleReasonCode: null,
          rightsStaleReasonRu: null,
        },
      });

      await client.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: computation.rightsProfileId,
          rightsReviewId: computation.approvedRightsReviewId,
          trigger: triggerDbValue(trigger) as never,
          previousHash: null,
          currentHash: computation.hash,
          hashAlgorithmVersion: computation.algorithmVersion,
          staleMarked: false,
          reasonCode: opensDraftFillWindow ? DRAFT_FILL_WINDOW_OPENED_REASON_CODE : null,
          reasonRu: opensDraftFillWindow
            ? 'Версия заведена черновиком: открыто окно наполнения, до первой публикации правка текста переснимает baseline'
            : null,
          createdByUserId: userId ?? null,
        },
      });

      return computation;
    });
  }

  async checkVersionStaleness(
    versionId: string,
    trigger: Trigger,
    userId?: string | null,
    persist = false,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashCheckDto> {
    const client = tx ?? this.prisma;

    const version = await client.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        status: true,
        publishedAt: true,
        rightsContentHash: true,
        rightsContentHashAlgorithmVersion: true,
        rightsRecheckRequired: true,
        rightsStaleReasonCode: true,
        rightsStaleReasonRu: true,
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const computation = await this.computeVersionHash(versionId, tx);
    const baselineHash = version.rightsContentHash;

    /**
     * WP-7: baseline, снятый под прошлой версией алгоритма, с текущим хешем несравним —
     * различаются они по составу входа, а не по содержимому книги. Пометить такую версию
     * stale значило бы обнулить клиренс всех книг на выкате (`RightsReview` уходит в `STALE`,
     * гейт закрывается) по причине, которой не было.
     *
     * Поэтому baseline **переснимается**, а уже стоящие метки stale не трогаются: снять их
     * может только настоящая проверка. Реальное изменение контента поймает следующий же вызов —
     * он сравнит два хеша одной версии алгоритма.
     */
    if (
      baselineHash &&
      version.rightsContentHashAlgorithmVersion !== computation.algorithmVersion
    ) {
      if (persist) {
        // LEGACY-036: пересъёмка меняет baseline и пишет о ней событие — вместе или никак.
        await this.inTransaction(tx, (writeClient) =>
          this.rebaselineForAlgorithmChange(
            versionId,
            computation,
            baselineHash,
            userId,
            writeClient,
          ),
        );
      }

      return {
        versionId: version.id,
        baselineHash,
        currentHash: computation.hash,
        algorithmVersion: computation.algorithmVersion,
        matchesBaseline: true,
        isStale: version.rightsRecheckRequired,
        recheckRequired: version.rightsRecheckRequired,
        reasonCode: version.rightsStaleReasonCode ?? null,
        reasonRu: version.rightsStaleReasonRu ?? null,
        checkedAt: new Date().toISOString(),
      };
    }

    const matchesBaseline = baselineHash === computation.hash;
    const isStale = !matchesBaseline || version.rightsRecheckRequired;

    if (!matchesBaseline && persist) {
      // Окно переснимает **существующий** baseline. Версия без снимка вообще — не случай окна:
      // её блокирует `MISSING_RIGHTS_CONTENT_HASH`, и заводить снимок правкой главы значило бы
      // снимать блокер, а не сужать правило.
      const insideDraftFillWindow =
        baselineHash !== null &&
        DRAFT_FILL_WINDOW_TRIGGERS.includes(trigger) &&
        (await this.isDraftFillWindowOpen(versionId, version.status, version.publishedAt, client));

      if (insideDraftFillWindow) {
        await this.inTransaction(tx, (writeClient) =>
          this.rebaselineWithinDraftFillWindow(
            versionId,
            computation,
            baselineHash,
            trigger,
            userId,
            writeClient,
          ),
        );

        return {
          versionId: version.id,
          baselineHash,
          currentHash: computation.hash,
          algorithmVersion: computation.algorithmVersion,
          matchesBaseline: true,
          isStale: version.rightsRecheckRequired,
          recheckRequired: version.rightsRecheckRequired,
          reasonCode: version.rightsStaleReasonCode ?? null,
          reasonRu: version.rightsStaleReasonRu ?? null,
          checkedAt: new Date().toISOString(),
        };
      }

      // LEGACY-036: сюда передавался `client`, то есть корневой клиент, когда своей транзакции
      // не было. `markVersionAndClearanceStale` видел непустой `tx` и свою транзакцию не открывал
      // вовсе — три записи (версия, клиренс, событие) шли врозь. Передаётся сам `tx`.
      await this.markVersionAndClearanceStale(
        versionId,
        trigger,
        computation.hash,
        baselineHash,
        userId,
        tx,
      );
    }

    if (persist && matchesBaseline) {
      await client.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: computation.rightsProfileId,
          rightsReviewId: computation.approvedRightsReviewId,
          trigger: triggerDbValue(trigger) as never,
          previousHash: baselineHash,
          currentHash: computation.hash,
          hashAlgorithmVersion: computation.algorithmVersion,
          staleMarked: !matchesBaseline,
          reasonCode: !matchesBaseline ? trigger : null,
          reasonRu: !matchesBaseline ? TRIGGER_MESSAGES[trigger] : null,
          createdByUserId: userId ?? null,
        },
      });
    }

    return {
      versionId: version.id,
      baselineHash,
      currentHash: computation.hash,
      algorithmVersion: computation.algorithmVersion,
      matchesBaseline,
      isStale,
      recheckRequired: version.rightsRecheckRequired || !matchesBaseline,
      reasonCode: version.rightsStaleReasonCode ?? (!matchesBaseline ? trigger : null),
      reasonRu:
        version.rightsStaleReasonRu ?? (!matchesBaseline ? TRIGGER_MESSAGES[trigger] : null),
      checkedAt: new Date().toISOString(),
    };
  }

  /**
   * Пересъёмка baseline после смены версии алгоритма хеша. Обновляет только сам снимок:
   * `rightsRecheckRequired` и метки stale остаются как были — пересъёмка ничего не проверяет
   * и потому ничего не разблокирует.
   */
  private async rebaselineForAlgorithmChange(
    versionId: string,
    computation: RightsContentHashComputationDto,
    previousHash: string,
    userId: string | null | undefined,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    await client.bookVersion.update({
      where: { id: versionId },
      data: {
        rightsContentHash: computation.hash,
        rightsContentHashAlgorithmVersion: computation.algorithmVersion,
        rightsContentHashInput: JSON.parse(
          JSON.stringify(computation.input),
        ) as Prisma.InputJsonValue,
        rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
      },
    });

    await client.rightsContentHashEvent.create({
      data: {
        bookVersionId: versionId,
        rightsProfileId: computation.rightsProfileId,
        rightsReviewId: computation.approvedRightsReviewId,
        trigger: 'MANUAL_HASH_CHECK' as never,
        previousHash,
        currentHash: computation.hash,
        hashAlgorithmVersion: computation.algorithmVersion,
        staleMarked: false,
        reasonCode: 'HASH_ALGORITHM_CHANGED',
        reasonRu:
          'Baseline пересчитан: изменился состав входа хеша, содержимое версии не проверялось',
        createdByUserId: userId ?? null,
      },
    });
  }

  /**
   * WP-D.1 / D.4. Открыто ли окно наполнения для этой версии. Единственное место, где это
   * решается: тем же условием пользуется пересъёмка baseline по профилю прав (D.2).
   *
   * Правило fail-closed — окно открыто, только если это доказано данными:
   *  1) версия сейчас черновик и никогда не была опубликована (`publishedAt` пуст);
   *  2) окно не закрывалось публикацией (событие `DRAFT_FILL_WINDOW_CLOSED`);
   *  3) окно было явно открыто при заведении версии (`DRAFT_FILL_WINDOW_OPENED`).
   *
   * Третий пункт закрывает версии, опубликованные до выката пакета: события закрытия у них
   * нет и быть не может, а `unpublish` обнуляет `publishedAt`, — без отметки открытия такая
   * версия молча переснимала бы baseline вместо `STALE`.
   */
  private async isDraftFillWindowOpen(
    versionId: string,
    status: string | null | undefined,
    publishedAt: Date | null | undefined,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<boolean> {
    if (status !== 'draft') return false;
    if (publishedAt) return false;

    const closingEvent = await client.rightsContentHashEvent.findFirst({
      where: { bookVersionId: versionId, reasonCode: DRAFT_FILL_WINDOW_CLOSED_REASON_CODE },
      select: { id: true },
    });
    if (closingEvent) return false;

    const openingEvent = await client.rightsContentHashEvent.findFirst({
      where: { bookVersionId: versionId, reasonCode: DRAFT_FILL_WINDOW_OPENED_REASON_CODE },
      select: { id: true },
    });

    return Boolean(openingEvent);
  }

  /**
   * WP-D.1. Пересъёмка baseline внутри окна наполнения: обновляется только снимок.
   * `rightsRecheckRequired` и уже стоящие метки stale не трогаются — окно ничего не проверяет
   * и потому ничего не разблокирует. Статусы `RightsReview` и `RightsProfile` не меняются.
   */
  private async rebaselineWithinDraftFillWindow(
    versionId: string,
    computation: RightsContentHashComputationDto,
    previousHash: string | null,
    trigger: Trigger,
    userId: string | null | undefined,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<void> {
    await client.bookVersion.update({
      where: { id: versionId },
      data: {
        rightsContentHash: computation.hash,
        rightsContentHashAlgorithmVersion: computation.algorithmVersion,
        rightsContentHashInput: JSON.parse(
          JSON.stringify(computation.input),
        ) as Prisma.InputJsonValue,
        rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
      },
    });

    await client.rightsContentHashEvent.create({
      data: {
        bookVersionId: versionId,
        rightsProfileId: computation.rightsProfileId,
        rightsReviewId: computation.approvedRightsReviewId,
        trigger: triggerDbValue(trigger) as never,
        previousHash,
        currentHash: computation.hash,
        hashAlgorithmVersion: computation.algorithmVersion,
        staleMarked: false,
        reasonCode: DRAFT_FILL_WINDOW_REASON_CODE,
        reasonRu: `${TRIGGER_MESSAGES[trigger]}. Версия в черновике: baseline переснят, клиренс не аннулирован`,
        createdByUserId: userId ?? null,
      },
    });
  }

  /**
   * WP-D.4. Жёсткий выход из окна наполнения: первая публикация фиксирует слепок окончательно.
   * Событие с `reasonCode = DRAFT_FILL_WINDOW_CLOSED` и есть признак закрытия — после него
   * правка главы снова уводит клиренс в `STALE`, даже если версию потом снимут с публикации.
   * Метки stale не снимаются: фиксация ничего не проверяет.
   */
  async finalizeBaselineOnPublish(
    versionId: string,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;

    const version = await client.bookVersion.findUnique({
      where: { id: versionId },
      select: { id: true, rightsContentHash: true },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const computation = await this.computeVersionHash(versionId, tx);

    // LEGACY-036: фиксация слепка и событие о закрытии окна ложатся вместе.
    await this.inTransaction(tx, async (writeClient) => {
      await writeClient.bookVersion.update({
        where: { id: versionId },
        data: {
          rightsContentHash: computation.hash,
          rightsContentHashAlgorithmVersion: computation.algorithmVersion,
          rightsContentHashInput: JSON.parse(
            JSON.stringify(computation.input),
          ) as Prisma.InputJsonValue,
          rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
        },
      });

      await writeClient.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: computation.rightsProfileId,
          rightsReviewId: computation.approvedRightsReviewId,
          trigger: 'MANUAL_HASH_CHECK' as never,
          previousHash: version.rightsContentHash,
          currentHash: computation.hash,
          hashAlgorithmVersion: computation.algorithmVersion,
          staleMarked: false,
          reasonCode: DRAFT_FILL_WINDOW_CLOSED_REASON_CODE,
          reasonRu:
            'Публикация версии: слепок контента зафиксирован окончательно, окно наполнения черновика закрыто',
          createdByUserId: userId ?? null,
        },
      });
    });
  }

  /**
   * WP-D.2. Пересъёмка baseline версий профиля прав без пометки stale.
   * Используется там, где вход хеша меняет артефакт происхождения, а не само произведение:
   * первое появление файла источника там, где его не было.
   *
   * Послабление действует только внутри окна наполнения черновика — того же, что и в D.1.
   * У версии, чьё окно закрыто публикацией, слепок зафиксирован, и смена входа обязана уводить
   * клиренс в `STALE` по прежнему правилу. Событие в аудит пишется в обоих случаях (ADR-009).
   */
  async rebaselineForRightsProfile(
    rightsProfileId: string,
    trigger: Trigger,
    reasonCode: string,
    reasonRu: string,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;

    const versions = await client.bookVersion.findMany({
      where: { rightsProfileId },
      select: { id: true, rightsContentHash: true, status: true, publishedAt: true },
    });

    for (const version of versions) {
      const insideDraftFillWindow = await this.isDraftFillWindowOpen(
        version.id,
        version.status,
        version.publishedAt,
        client,
      );

      if (!insideDraftFillWindow) {
        await this.checkVersionStaleness(version.id, trigger, userId ?? null, true, tx);
        continue;
      }

      const computation = await this.computeVersionHash(version.id, tx);

      // LEGACY-036: транзакция на версию, а не на весь цикл: пересъёмка профиля идёт по всем
      // версиям и устроена как частичный успех, а одна транзакция на цикл держала бы строки
      // всех версий профиля до конца обхода.
      await this.inTransaction(tx, async (writeClient) => {
        await writeClient.bookVersion.update({
          where: { id: version.id },
          data: {
            rightsContentHash: computation.hash,
            rightsContentHashAlgorithmVersion: computation.algorithmVersion,
            rightsContentHashInput: JSON.parse(
              JSON.stringify(computation.input),
            ) as Prisma.InputJsonValue,
            rightsContentHashCalculatedAt: new Date(computation.calculatedAt),
          },
        });

        await writeClient.rightsContentHashEvent.create({
          data: {
            bookVersionId: version.id,
            rightsProfileId: computation.rightsProfileId,
            rightsReviewId: computation.approvedRightsReviewId,
            trigger: triggerDbValue(trigger) as never,
            previousHash: version.rightsContentHash,
            currentHash: computation.hash,
            hashAlgorithmVersion: computation.algorithmVersion,
            staleMarked: false,
            reasonCode,
            reasonRu,
            createdByUserId: userId ?? null,
          },
        });
      });
    }
  }

  async markVersionAndClearanceStale(
    versionId: string,
    trigger: Trigger,
    currentHash: string,
    previousHash: string | null,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<void> {
    const client = tx ?? this.prisma;
    const version = await client.bookVersion.findUnique({
      where: { id: versionId },
      select: {
        id: true,
        rightsProfileId: true,
        approvedRightsReviewId: true,
        rightsStaleDetectedAt: true,
      },
    });

    if (!version) {
      throw new NotFoundException('BookVersion not found');
    }

    const now = new Date();
    const reasonCode = trigger;
    const reasonRu = TRIGGER_MESSAGES[trigger];
    const staleReason = {
      rightsStaleDetectedAt: now,
      rightsStaleReasonCode: reasonCode,
      rightsStaleReasonRu: reasonRu,
    };

    // LEGACY-036, решение арбитра от 04.09.2026 (`decisions-log.md`): в транзакции лежит
    // аудит-пара — своя версия, статусы клиренса и событие. Пометка родственных версий
    // (`SHARED_CLEARANCE_STALE`) вынесена за транзакцию и идёт после её коммита: держа чужие
    // строки версий, новая транзакция путей без своего `tx` брала их крест-накрест со встречной
    // правкой главы. Дедлок `tx`-против-`tx` этим не закрыт — он состояние `main` и живёт
    // записью техдолга; `orderBy` ниже окно сужает, но по `L-019` закрытием не считается.
    const markSelf = async (client: Prisma.TransactionClient): Promise<void> => {
      await client.bookVersion.update({
        where: { id: versionId },
        data: {
          rightsRecheckRequired: true,
          ...staleReason,
        },
      });

      if (version.approvedRightsReviewId) {
        await client.rightsReview.update({
          where: { id: version.approvedRightsReviewId },
          data: {
            status: 'STALE' as never,
            staleDetectedAt: now,
            staleReasonCode: reasonCode,
            staleReasonRu: reasonRu,
          },
        });
      }

      if (version.rightsProfileId) {
        await client.rightsProfile.update({
          where: { id: version.rightsProfileId },
          data: {
            status: 'STALE' as never,
            staleDetectedAt: now,
            staleReasonCode: reasonCode,
            staleReasonRu: reasonRu,
          },
        });
      }

      await client.rightsContentHashEvent.create({
        data: {
          bookVersionId: versionId,
          rightsProfileId: version.rightsProfileId,
          rightsReviewId: version.approvedRightsReviewId,
          trigger: triggerDbValue(trigger) as never,
          previousHash,
          currentHash,
          hashAlgorithmVersion: RIGHTS_CONTENT_HASH_ALGORITHM_VERSION,
          staleMarked: true,
          reasonCode,
          reasonRu,
          createdByUserId: userId ?? null,
        },
      });
    };

    await this.inTransaction(tx, markSelf);

    // Клиренс общий, поэтому его протухание переносится на соседние версии. Своей транзакции
    // этот обход не открывает: у вызывающего со своим `tx` он остаётся внутри неё, как и был,
    // а на путях без `tx` идёт по строке — прежним поведением до LEGACY-036.
    const fanOutClient = tx ?? this.prisma;

    const markRelated = async (
      where: Prisma.BookVersionWhereInput,
      reasonRuText: string,
    ): Promise<void> => {
      const relatedVersions = await fanOutClient.bookVersion.findMany({
        where: { ...where, id: { not: versionId }, rightsStaleDetectedAt: null },
        select: { id: true },
        orderBy: { id: 'asc' },
      });

      for (const relatedVersion of relatedVersions) {
        await fanOutClient.bookVersion.update({
          where: { id: relatedVersion.id },
          data: {
            rightsRecheckRequired: true,
            rightsStaleDetectedAt: now,
            rightsStaleReasonCode: 'SHARED_CLEARANCE_STALE',
            rightsStaleReasonRu: reasonRuText,
          },
        });
      }
    };

    if (version.approvedRightsReviewId) {
      await markRelated(
        { approvedRightsReviewId: version.approvedRightsReviewId },
        'Изменение контента в другой версии той же проверки прав. Требуется повторная проверка.',
      );
    }

    if (version.rightsProfileId) {
      await markRelated(
        { rightsProfileId: version.rightsProfileId },
        'Изменение контента в другой версии того же профиля прав. Требуется повторная проверка.',
      );
    }
  }

  /**
   * WP-8.1. В хеш входит то, от чего зависит правовое основание: кто участник, в какой роли
   * и какие у него годы жизни. Порядок в списке кредитов (`displayOrder`, `isPrimary`) и
   * редакционная заметка — оформление: перестановка кредитов не должна закрывать гейт.
   */
  private serializeVersionContributors(
    contributors: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return contributors
      .map((c) => {
        const person = (c['person'] as Record<string, unknown> | null) ?? null;
        return {
          role: c['role'],
          roleOtherRu: c['roleOtherRu'] ?? null,
          personId: c['personId'] ?? null,
          creditedName: c['creditedName'] ?? null,
          confidence: c['confidence'] ?? null,
          person: person
            ? {
                canonicalName: person['canonicalName'] ?? null,
                birthYear: person['birthYear'] ?? null,
                deathYear: person['deathYear'] ?? null,
                publicDomainFromYear: person['publicDomainFromYear'] ?? null,
                nationalityCountryCode: person['nationalityCountryCode'] ?? null,
              }
            : null,
        };
      })
      .sort((a, b) => contributorSortKey(a).localeCompare(contributorSortKey(b)));
  }

  /**
   * Участники профиля прав хранят годы жизни собственной копией (`RightsProfileContributor`
   * заполняется материализацией отчёта), поэтому персона здесь не догружается.
   */
  private serializeProfileContributors(
    contributors: Array<Record<string, unknown>>,
  ): Array<Record<string, unknown>> {
    return contributors
      .map((c) => ({
        role: c['role'],
        roleOtherRu: c['roleOtherRu'] ?? null,
        rightsComponentId: c['rightsComponentId'] ?? null,
        personId: c['personId'] ?? null,
        displayName: c['displayName'] ?? null,
        canonicalName: c['canonicalName'] ?? null,
        creditedName: c['creditedName'] ?? null,
        birthYear: c['birthYear'] ?? null,
        deathYear: c['deathYear'] ?? null,
        publicDomainFromYear: c['publicDomainFromYear'] ?? null,
        nationalityCountryCode: c['nationalityCountryCode'] ?? null,
        confidence: c['confidence'] ?? null,
      }))
      .sort((a, b) => contributorSortKey(a).localeCompare(contributorSortKey(b)));
  }

  /**
   * WP-8.2. У обложки нет отношения к `MediaAsset` — в модели это строка URL, — поэтому
   * ассет ищется по адресу. Не нашли (внешний CDN, ручная правка URL) → в хеш идёт `null`,
   * то есть остаётся прежнее поведение «только адрес», а не ошибка.
   */
  private async resolveCoverMedia(
    coverImageUrl: string | null,
    client: Prisma.TransactionClient | PrismaService,
  ): Promise<Record<string, unknown> | null> {
    if (!coverImageUrl) return null;

    const asset = await client.mediaAsset.findFirst({
      where: { url: coverImageUrl },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        key: true,
        contentType: true,
        size: true,
        hash: true,
        isDeleted: true,
      },
    });

    if (!asset) return null;

    return {
      id: asset.id,
      key: asset.key,
      contentType: asset.contentType ?? null,
      size: asset.size ?? null,
      hash: asset.hash ?? null,
      isDeleted: asset.isDeleted ?? false,
    };
  }

  /**
   * WP-8.1. Правка персоны и связей профиля не проходит через версию, поэтому проверка
   * разворачивается в обратную сторону: от участника ко всем версиям, где он учтён —
   * напрямую (`BookVersionContributor`) или через профиль прав (`RightsProfileContributor`).
   */
  async checkStalenessForPerson(
    personId: string,
    trigger: Trigger,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashCheckDto[]> {
    const client = tx ?? this.prisma;

    const directLinks = await client.bookVersionContributor.findMany({
      where: { personId },
      select: { bookVersionId: true },
    });

    const profileLinks = await client.rightsProfileContributor.findMany({
      where: { personId },
      select: { rightsProfileId: true },
    });

    const versionIds = new Set(directLinks.map((link) => link.bookVersionId));

    const profileIds = [...new Set(profileLinks.map((link) => link.rightsProfileId))];
    if (profileIds.length > 0) {
      const profileVersions = await client.bookVersion.findMany({
        where: { rightsProfileId: { in: profileIds } },
        select: { id: true },
      });
      for (const version of profileVersions) {
        versionIds.add(version.id);
      }
    }

    return this.checkStalenessForVersions([...versionIds], trigger, userId, tx);
  }

  /**
   * Версии профиля прав: используется при привязке и отвязке участника профиля, где
   * конкретная персона может быть неизвестна (связь допускает `personId = null`).
   */
  async checkStalenessForRightsProfile(
    rightsProfileId: string,
    trigger: Trigger,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashCheckDto[]> {
    const client = tx ?? this.prisma;

    const versions = await client.bookVersion.findMany({
      where: { rightsProfileId },
      select: { id: true },
    });

    return this.checkStalenessForVersions(
      versions.map((version) => version.id),
      trigger,
      userId,
      tx,
    );
  }

  private async checkStalenessForVersions(
    versionIds: string[],
    trigger: Trigger,
    userId?: string | null,
    tx?: Prisma.TransactionClient,
  ): Promise<RightsContentHashCheckDto[]> {
    const results: RightsContentHashCheckDto[] = [];

    for (const versionId of versionIds) {
      results.push(await this.checkVersionStaleness(versionId, trigger, userId ?? null, true, tx));
    }

    return results;
  }

  private serializeSourceEdition(
    sourceEdition: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!sourceEdition) return null;
    return {
      provider: sourceEdition['provider'],
      externalId: sourceEdition['externalId'] ?? null,
      sourceUrl: sourceEdition['sourceUrl'] ?? null,
      sourceTitle: sourceEdition['sourceTitle'] ?? null,
      sourceLanguage: sourceEdition['sourceLanguage'] ?? null,
      sourceTextType: sourceEdition['sourceTextType'],
      gutenbergStatus: sourceEdition['gutenbergStatus'] ?? null,
      status: sourceEdition['status'],
      // WP-8.3 (R3-05): контрольная сумма самого файла источника. До неё хешировались только
      // метаданные, поэтому подмена файла по тому же адресу оставалась невидимой — ровно тот
      // класс, что WP-8.2 закрыл для обложки. Ключ, имя, MIME и размер в хеш не входят:
      // они сопровождают файл, но не меняют произведение (ADR-010).
      sourceFileSha256: sourceEdition['sourceFileSha256'] ?? null,
      // WP-7.1: права издания — запись на язык. Порядок фиксируется по коду языка,
      // иначе хеш зависел бы от порядка выдачи БД.
      editionRights: ((sourceEdition['editionRights'] as Array<Record<string, unknown>>) || [])
        .map((er) => ({
          languageCode: (er['languageCode'] as string | null) ?? '',
          status: er['status'],
          legalBasisRu: er['legalBasisRu'] ?? null,
          notesRu: er['notesRu'] ?? null,
          translationOrigin: er['translationOrigin'] ?? null,
          translationSourceLanguage: er['translationSourceLanguage'] ?? null,
          requiresGeoBlock: er['requiresGeoBlock'] ?? false,
        }))
        .sort((a, b) => a.languageCode.localeCompare(b.languageCode)),
    };
  }

  private serializeReviewImport(
    reviewImport: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!reviewImport) return null;
    return {
      schemaVersion: reviewImport['schemaVersion'] ?? null,
      sourceFileName: reviewImport['sourceFileName'] ?? null,
      reportJsonSha256: reviewImport['reportJsonSha256'] ?? null,
      reportMarkdownSha256: reviewImport['reportMarkdownSha256'] ?? null,
      rawAgentOutputSha256: reviewImport['rawAgentOutputSha256'] ?? null,
    };
  }
}
