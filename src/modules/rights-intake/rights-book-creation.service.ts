import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { classifyTerritoryDecisions } from '../rights-clearance/rights-clearance.util';
import { CreateBookFromClearanceDto } from './dto/create-book-from-clearance.dto';
import { CreateBookFromClearanceResponseDto } from './dto/create-book-from-clearance-response.dto';
import { RightsContentHashService } from './rights-content-hash.service';
import { hasEffectiveLawyerApproval } from './rights-lawyer-approval.util';
import { BOOK_CREATION_ERROR_CODES, BookCreationErrorCode } from './rights-book-creation.constants';
import { RightsLicenseCoverageService } from '../rights-licenses/rights-license-coverage.service';
import { CreateBookFromClearanceVersionDto } from './dto/create-book-from-clearance-version.dto';
import { BookType, Prisma } from '@prisma/client';

/**
 * WP-L.2: версия, на которую ложится снимок прав. В обычном режиме она создаётся из запроса, в
 * режиме привязки уже существует — весь расчёт ниже одинаков для обеих веток.
 */
interface ClearanceVersionPlan {
  language: string;
  type: BookType;
  existingVersionId: string | null;
  dto: CreateBookFromClearanceVersionDto | null;
}

/** WP-H: тело отказа с машинным кодом. Текст сообщения остаётся прежним. */
const failure = (
  code: BookCreationErrorCode,
  message: string,
  messageRu: string,
  details?: Record<string, unknown>,
) => ({ code, message, messageRu, ...(details ? { details } : {}) });

@Injectable()
export class RightsBookCreationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
    private readonly licenseCoverageService: RightsLicenseCoverageService,
  ) {}

  private get ri() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsIntake'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get rr() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsReview'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get rp() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsProfile'] as {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get ra() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsAction'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  private get td() {
    return (this.prisma as unknown as Record<string, unknown>)['territoryDecision'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
  }

  async createBookFromApprovedClearance(
    intakeId: string,
    dto: CreateBookFromClearanceDto,
  ): Promise<CreateBookFromClearanceResponseDto> {
    // 1. Find RightsIntake
    const intake = await this.ri.findUnique({ where: { id: intakeId } });
    if (!intake) {
      throw new NotFoundException(
        failure(
          BOOK_CREATION_ERROR_CODES.INTAKE_NOT_FOUND,
          `RightsIntake with ID '${intakeId}' not found`,
          'Проверка авторских прав с таким идентификатором не найдена.',
          { intakeId },
        ),
      );
    }

    // 2. Check intake status is APPROVED
    if (intake['workflowStatus'] !== 'APPROVED') {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.INTAKE_NOT_APPROVED,
          `Cannot create book: intake status is '${String(intake['workflowStatus'])}', expected 'APPROVED'`,
          'Книгу нельзя создать: проверка прав ещё не утверждена.',
          { workflowStatus: intake['workflowStatus'] ?? null, expected: 'APPROVED' },
        ),
      );
    }

    // 3. Check approvedReviewId exists
    const approvedReviewId = intake['approvedReviewId'] as string | null;
    if (!approvedReviewId) {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.INTAKE_HAS_NO_APPROVED_REVIEW,
          'Cannot create book: intake has no approved review',
          'Книгу нельзя создать: у проверки прав нет утверждённого отчёта.',
        ),
      );
    }

    // 4. Check createdBookId is null (book not already created)
    if (intake['createdBookId']) {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.BOOK_ALREADY_CREATED,
          'Cannot create book: book already created for this intake',
          'Книга по этой проверке прав уже создана.',
          { bookId: intake['createdBookId'] },
        ),
      );
    }

    // 5. Find approved RightsReview
    const review = await this.rr.findUnique({
      where: { id: approvedReviewId },
      include: { rightsProfile: true },
    });
    if (!review) {
      throw new NotFoundException(
        failure(
          BOOK_CREATION_ERROR_CODES.APPROVED_REVIEW_NOT_FOUND,
          `Approved RightsReview with ID '${approvedReviewId}' not found`,
          'Утверждённый отчёт проверки прав не найден в базе данных.',
          { approvedReviewId },
        ),
      );
    }

    // 6. Check review status is HUMAN_APPROVED
    if (review['status'] !== 'HUMAN_APPROVED') {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.REVIEW_NOT_APPROVED,
          `Cannot create book: review status is '${String(review['status'])}', expected 'HUMAN_APPROVED'`,
          'Книгу нельзя создать: отчёт проверки прав не утверждён человеком.',
          { status: review['status'] ?? null, expected: 'HUMAN_APPROVED' },
        ),
      );
    }

    // 7. Find current RightsProfile
    const profile = review['rightsProfile'] as Record<string, unknown>;
    const profileId = profile['id'] as string;
    const profileIntakeId = profile['rightsIntakeId'] as string;

    // 8. Check profile is current
    if (!profile['isCurrent']) {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.PROFILE_NOT_CURRENT,
          'Cannot create book: rights profile is not current',
          'Книгу нельзя создать: профиль прав не является действующим.',
        ),
      );
    }

    // 9. Check profile status is APPROVED
    if (profile['status'] !== 'APPROVED') {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.PROFILE_NOT_APPROVED,
          `Cannot create book: profile status is '${String(profile['status'])}', expected 'APPROVED'`,
          'Книгу нельзя создать: профиль прав не утверждён.',
          { status: profile['status'] ?? null, expected: 'APPROVED' },
        ),
      );
    }

    // 10. Check profile belongs to this intake
    if (profileIntakeId !== intakeId) {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.PROFILE_INTAKE_MISMATCH,
          'Cannot create book: profile belongs to different intake',
          'Книгу нельзя создать: профиль прав принадлежит другой проверке.',
        ),
      );
    }

    // 11. Check publicationGate is not BLOCK.
    // WP-M: действующее заключение юриста перекрывает вердикт агента и здесь тоже — иначе интейк
    // был бы утверждён, а книгу по нему создать всё равно было бы нельзя. Условие то же, что в
    // `rights-approval.service.ts`, и читается из того же снимка на профиле (ADR-003).
    if (!hasEffectiveLawyerApproval(profile) && profile['publicationGate'] === 'BLOCK') {
      throw new BadRequestException(
        failure(
          BOOK_CREATION_ERROR_CODES.PUBLICATION_GATE_BLOCK,
          'Cannot create book: publication gate is BLOCK',
          'Книгу нельзя создать: по результатам проверки прав публикация запрещена.',
        ),
      );
    }

    // 12. Незакрытое блокирующее действие больше не запрещает создание книги (WP-H).
    // Создание книги — подготовка: наружу не уходит ничего, версия заводится черновиком. При этом
    // само действие часто невыполнимо, пока книги нет (убрать компонент можно только из имеющейся
    // версии), и правило было тупиком. Проверка не исчезла, а осталась там, где она про результат:
    // при утверждении интейка (`rights-approval.service.ts`) и в гейте публикации, блок 6.12
    // (`UNRESOLVED_BLOCKING_RIGHTS_ACTION`) — опубликовать версию с открытым блокирующим действием
    // по-прежнему нельзя.

    // 13. Resolve the target book: create a new one or attach to the existing one (WP-L.2).
    const attachToExisting = dto.attachToExistingBook === true;
    const bookByOwnSlug = await this.prisma.book.findUnique({ where: { slug: dto.slug } });
    const targetLanguages = intake['targetLanguages'] as string[];

    // WP-L.2: «слаг книги» в приложении — это `BookVersion.slug`; `Book.slug` остался legacy и в
    // `findBySlug` / `getOverview` служит запасным вариантом. Редактор знает именно версионный
    // слаг — он в публичном адресе, — поэтому привязка ищет книгу так же, как читающая сторона.
    // Проверка занятости слага при **создании** осталась прежней (только `Book.slug`): расширять
    // её — менять поведение, к смягчению не относящееся.
    const existingBook =
      bookByOwnSlug ??
      (attachToExisting
        ? await this.prisma.bookVersion
            .findFirst({ where: { slug: dto.slug }, select: { book: true } })
            .then((version) => version?.book ?? null)
        : null);

    if (!attachToExisting && bookByOwnSlug) {
      throw new ConflictException(
        failure(
          BOOK_CREATION_ERROR_CODES.SLUG_TAKEN,
          `Book with slug '${dto.slug}' already exists`,
          'Книга с таким слагом уже существует.',
          { slug: dto.slug },
        ),
      );
    }

    // Версии, на которые ляжет снимок прав. В режиме привязки они уже существуют.
    let versionPlan: ClearanceVersionPlan[];
    let attachTargetBookId: string | null = null;

    if (attachToExisting) {
      if (!existingBook) {
        throw new NotFoundException(
          failure(
            BOOK_CREATION_ERROR_CODES.BOOK_NOT_FOUND,
            `No book found by slug '${dto.slug}' (neither Book.slug nor BookVersion.slug)`,
            'Книга с таким слагом не найдена: искали и по слагу книги, и по слагам её версий. Привязывать клиренс не к чему.',
            { slug: dto.slug, searchedIn: ['Book.slug', 'BookVersion.slug'] },
          ),
        );
      }
      if (dto.versions && dto.versions.length > 0) {
        throw new BadRequestException(
          failure(
            BOOK_CREATION_ERROR_CODES.VERSIONS_NOT_ALLOWED_WHEN_ATTACHING,
            'Cannot pass versions when attaching the clearance to an existing book',
            'При привязке к существующей книге версии не передаются: снимок прав получают уже заведённые версии.',
          ),
        );
      }
      // Чужой действующий клиренс не перетирается: снимок на версиях и профиль книги разошлись бы
      // молча, а гейт сравнивает их напрямую (`RIGHTS_PROFILE_SNAPSHOT_OUTDATED`).
      const currentProfileId = existingBook.currentRightsProfileId;
      if (currentProfileId && currentProfileId !== profileId) {
        throw new ConflictException(
          failure(
            BOOK_CREATION_ERROR_CODES.BOOK_ALREADY_UNDER_CLEARANCE,
            `Book '${dto.slug}' is already covered by another rights profile`,
            'К этой книге уже привязан другой профиль прав.',
            { slug: dto.slug, currentRightsProfileId: currentProfileId },
          ),
        );
      }

      const bookVersions = await this.prisma.bookVersion.findMany({
        where: { bookId: existingBook.id },
        select: { id: true, language: true, type: true },
        orderBy: { createdAt: 'asc' },
      });
      // Версии на языках вне клиренса намеренно остаются без профиля: ADR-014 требует реальной
      // оценки на язык версии, и гейт закроет их кодом `MISSING_LANGUAGE_RIGHTS_ASSESSMENT`.
      // Молча выдать им чужой снимок было бы хуже отказа.
      const covered = bookVersions.filter((version) => targetLanguages.includes(version.language));
      if (covered.length === 0) {
        throw new BadRequestException(
          failure(
            BOOK_CREATION_ERROR_CODES.NO_VERSIONS_IN_TARGET_LANGUAGES,
            `Book '${dto.slug}' has no versions in the target languages of this clearance`,
            'У книги нет ни одной версии на целевых языках этой проверки прав.',
            {
              slug: dto.slug,
              targetLanguages,
              bookLanguages: bookVersions.map((version) => version.language),
            },
          ),
        );
      }

      attachTargetBookId = existingBook.id;
      versionPlan = covered.map((version) => ({
        language: version.language,
        type: version.type,
        existingVersionId: version.id,
        dto: null,
      }));
    } else {
      // 14. Validate versions against targetLanguages
      for (const version of dto.versions) {
        if (!targetLanguages.includes(version.language)) {
          throw new BadRequestException(
            failure(
              BOOK_CREATION_ERROR_CODES.LANGUAGE_NOT_TARGETED,
              `Cannot create version for language '${version.language}': not in target languages`,
              'Версию нельзя создать: язык не входит в целевые языки проверки прав.',
              { language: version.language, targetLanguages },
            ),
          );
        }
      }

      versionPlan = dto.versions.map((versionDto) => ({
        language: versionDto.language,
        type: versionDto.type,
        existingVersionId: null,
        dto: versionDto,
      }));
    }

    // 15. Get territory decisions for rights snapshot
    const territoryDecisions = await this.td.findMany({
      where: { rightsProfileId: profileId },
    });

    // 16. Compute rights snapshot. Same classifier the read-side resolver uses, so the audit
    // snapshot and the clearance in force can only differ because the clearance changed.
    const {
      allowedCountryCodes: allowedCountries,
      blockedCountryCodes: blockedCountries,
      licenseRequiredCountryCodes: licenseRequiredCountries,
      pendingCountryCodes: pendingCountries,
    } = classifyTerritoryDecisions(
      territoryDecisions.map((td) => ({
        countryCode: td['countryCode'] as string,
        accessPolicy: td['accessPolicy'] as string,
        finalStatus: td['finalStatus'] as string,
      })),
    );

    // 17. Get required actions snapshot
    const actions = await this.ra.findMany({
      where: { rightsProfileId: profileId },
    });

    const requiredActions = actions.map((a) => ({
      id: a['id'] as string,
      actionType: a['actionType'] as string,
      status: a['status'] as string,
      descriptionRu: a['descriptionRu'] as string,
      affectedCountryCodes: a['affectedCountryCodes'] as string[],
      isBlocking: a['isBlocking'] as boolean,
    }));

    // 17b. Phase 15: evaluate license coverage per version (language and format differ)
    const licenses = await this.licenseCoverageService.loadLicensesForProfile(profileId);
    const checkedAt = new Date();
    const coverageByVersion = versionPlan.map((planned) =>
      this.licenseCoverageService.evaluateCoverage({
        requiredCountryCodes: licenseRequiredCountries,
        languageCode: planned.language,
        requiredMediaFormats: this.licenseCoverageService.mediaFormatsForVersionType(planned.type),
        licenses,
        at: checkedAt,
      }),
    );
    const allVersionsLicensed =
      licenseRequiredCountries.length > 0 &&
      coverageByVersion.length > 0 &&
      coverageByVersion.every((coverage) => coverage.status === 'COVERED');

    // 18. Compute rights status
    let rightsStatus = 'APPROVED';
    if (profile['publicationGate'] === 'ALLOW_AFTER_GEO_CONFIGURATION') {
      rightsStatus = 'APPROVED_WITH_GEO_RESTRICTIONS';
    } else if (allVersionsLicensed) {
      rightsStatus = 'APPROVED_WITH_LICENSES';
    } else if (licenseRequiredCountries.length > 0) {
      rightsStatus = 'APPROVED_WITH_LICENSE_LIMITATIONS';
    } else if (pendingCountries.length > 0) {
      rightsStatus = 'APPROVED_WITH_PENDING_TERRITORIES';
    }

    // 19. Create Book and BookVersions in transaction
    const result = await this.prisma.$transaction(async (tx) => {
      const t = tx as unknown as Record<string, unknown>;
      const bookTx = t['book'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const bvTx = t['bookVersion'] as {
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
      const riTx = t['rightsIntake'] as {
        update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      const bookRightsFields = {
        rightsIntakeId: intakeId,
        currentRightsProfileId: profileId,
        approvedRightsReviewId: approvedReviewId,
        rightsCreatedAt: new Date(),
      };

      // Create the book, or bind the clearance to the existing one (WP-L.2).
      const book = attachTargetBookId
        ? await bookTx.update({ where: { id: attachTargetBookId }, data: bookRightsFields })
        : await bookTx.create({ data: { slug: dto.slug, ...bookRightsFields } });

      const bookId = book['id'] as string;

      // Create BookVersions
      const rllTx = t['rightsLicenseLink'] as {
        findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
        create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };

      const versions: Array<Record<string, unknown>> = [];
      for (let versionIndex = 0; versionIndex < versionPlan.length; versionIndex++) {
        const planned = versionPlan[versionIndex];
        const coverage = coverageByVersion[versionIndex];

        // Общая для обеих веток часть — то, что версия получает от клиренса. Контентные поля
        // (заголовок, описание, обложка) сюда не входят: у существующей версии они свои и
        // перетирать их привязкой прав нельзя.
        const rightsSnapshot = {
          rightsProfileId: profileId,
          approvedRightsReviewId: approvedReviewId,
          rightsStatus,
          rightsAllowedCountryCodes: allowedCountries,
          rightsBlockedCountryCodes: blockedCountries,
          rightsLicenseRequiredCountryCodes: licenseRequiredCountries,
          rightsPendingCountryCodes: pendingCountries,
          rightsRequiredActions: requiredActions,
          // Phase 7: Publication gate geo-block fields.
          // WP-A.1: `ALLOW_AFTER_GEO_CONFIGURATION` on its own no longer raises the flag — with
          // an empty list of blocked countries there is nothing to write a rule for, and the
          // gate demanded a rule that could not exist. The verdict of the agent is not weakened:
          // it still drives `rightsStatus` (APPROVED_WITH_GEO_RESTRICTIONS) and, as soon as it
          // names a closed market, that market raises the flag by itself.
          rightsGeoBlockRequired: blockedCountries.length > 0,
          rightsGeoBlockConfigured: false,
          rightsGeoBlockConfiguredAt: null,
          rightsGeoBlockNotesRu: null,
          // Phase 15: license snapshot
          rightsLicenseIds: coverage.licenseIds,
          rightsLicenseCoverageStatus: coverage.status,
          rightsLicenseCheckedAt: checkedAt,
          rightsLicenseUncoveredCountryCodes: coverage.uncoveredCountryCodes,
          rightsLicenseAttributionTextRu: coverage.attributionTextsRu.join('\n') || null,
        };

        if (planned.existingVersionId) {
          const attached = await bvTx.update({
            where: { id: planned.existingVersionId },
            data: rightsSnapshot,
          });
          versions.push(attached);
          await this.linkCoverageLicenses(rllTx, coverage.licenseIds, attached['id'] as string);
          continue;
        }

        const versionDto = planned.dto as CreateBookFromClearanceVersionDto;
        const version = await bvTx.create({
          data: {
            bookId,
            language: versionDto.language,
            title: versionDto.title,
            author: versionDto.author,
            // WP-L.1: пустая строка — не «забыли записать», а честное «контента ещё нет».
            // Колонки `NOT NULL` без дефолта (инцидент R4-01), поэтому дефолт ставится здесь, а
            // публикацию пустой оболочки закрывает блокер гейта `VERSION_CONTENT_INCOMPLETE`.
            description: versionDto.description ?? '',
            coverImageUrl: versionDto.coverImageUrl ?? '',
            type: versionDto.type,
            isFree: versionDto.isFree,
            referralUrl: versionDto.referralUrl ?? null,
            status: 'draft',
            ...rightsSnapshot,
            originalLanguage:
              versionDto.originalLanguage ?? (intake['originalLanguage'] as string | null),
            originalTitle: versionDto.originalTitle ?? (intake['originalTitle'] as string | null),
            copyrightStatus: versionDto.copyrightStatus ?? rightsStatus,
            primaryCategoryId: versionDto.primaryCategoryId ?? null,
            firstPublishedYear: versionDto.firstPublishedYear ?? null,
            editionPublishedYear: versionDto.editionPublishedYear ?? null,
            authorPageUrl: versionDto.authorPageUrl ?? null,
            authorId: versionDto.authorId ?? null,
            shortDescription: versionDto.shortDescription ?? null,
            summaryShort: versionDto.summaryShort ?? null,
            coverAlt: versionDto.coverAlt ?? null,
          },
        });

        await this.linkCoverageLicenses(rllTx, coverage.licenseIds, version['id'] as string);
        versions.push(version);
      }

      // Phase 8: Initialize content hash baselines for all created versions.
      // WP-8.1: участники проецируются ДО снятия baseline — с WP-8 они входят в хеш,
      // и снимок, снятый до них, сразу расходился бы с живым хешем: гейт закрывал бы
      // публикацию новой книги кодом RIGHTS_CONTENT_HASH_CHANGED.
      const bvcTx = t['bookVersionContributor'] as {
        count: (args: Record<string, unknown>) => Promise<number>;
      };

      const attachedVersionIds = new Set(
        versionPlan
          .map((planned) => planned.existingVersionId)
          .filter((id): id is string => id !== null),
      );

      for (const v of versions) {
        const versionId = v['id'] as string;
        // WP-L.2: у существующей версии участники уже заведены редактором вручную. Проекция из
        // профиля их не заменяет, а добавляет вторым комплектом — поэтому для неё сначала
        // спрашиваем, пуст ли список. У только что созданной версии он пуст по определению, и
        // лишнего запроса не делается. Baseline снимается после, так что хеш сходится в обоих
        // случаях.
        const alreadyHasContributors =
          attachedVersionIds.has(versionId) &&
          (await bvcTx.count({ where: { bookVersionId: versionId } })) > 0;
        if (!alreadyHasContributors) {
          await this.projectContributorsToVersion(
            tx as unknown as Prisma.TransactionClient,
            versionId,
            v['language'] as string,
            v['type'] as string,
            profileId,
            (intake['originalLanguage'] as string) || undefined,
          );
        }
        // Опубликованная версия окно наполнения черновика не получает — `initializeVersionBaseline`
        // проверяет статус сама (WP-D.1), правка здесь не нужна.
        await this.rightsContentHashService.initializeVersionBaseline(
          versionId,
          'INITIAL_VERSION_SNAPSHOT',
          null,
          tx,
        );
      }

      // Update RightsIntake
      await riTx.update({
        where: { id: intakeId },
        data: {
          workflowStatus: 'BOOK_CREATED',
          createdBookId: bookId,
        },
      });

      return { book, versions };
    });

    const book = result.book;
    const versions = result.versions;

    return {
      book: {
        id: book['id'] as string,
        slug: book['slug'] as string,
        rightsIntakeId: book['rightsIntakeId'] as string | null,
        currentRightsProfileId: book['currentRightsProfileId'] as string | null,
        approvedRightsReviewId: book['approvedRightsReviewId'] as string | null,
        rightsCreatedAt: book['rightsCreatedAt']
          ? new Date(book['rightsCreatedAt'] as string).toISOString()
          : null,
        createdAt: new Date(book['createdAt'] as string).toISOString(),
        updatedAt: new Date(book['updatedAt'] as string).toISOString(),
      },
      versions: versions.map((v) => ({
        id: v['id'] as string,
        bookId: v['bookId'] as string,
        language: v['language'] as string,
        title: v['title'] as string,
        status: v['status'] as string,
        rightsStatus: v['rightsStatus'] as string | null,
      })),
      rightsProfileId: profileId,
      approvedRightsReviewId: approvedReviewId,
    };
  }

  /**
   * Лицензии, которыми обоснована версия, переносятся на саму версию — гейт публикации ищет их
   * там и не ходит обратно в профиль. Повторный вызов безопасен: связь создаётся один раз.
   */
  private async linkCoverageLicenses(
    rllTx: {
      findFirst: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    },
    licenseIds: string[],
    bookVersionId: string,
  ): Promise<void> {
    for (const rightsLicenseId of licenseIds) {
      const existingLink = await rllTx.findFirst({ where: { rightsLicenseId, bookVersionId } });
      if (existingLink) continue;

      await rllTx.create({
        data: { rightsLicenseId, linkType: 'BOOK_VERSION', bookVersionId },
      });
    }
  }

  private async projectContributorsToVersion(
    tx: Prisma.TransactionClient,
    versionId: string,
    versionLanguage: string,
    versionType: string,
    profileId: string,
    originalLanguage?: string,
  ) {
    const t = tx as unknown as Record<string, unknown>;
    const rpcModel = t['rightsProfileContributor'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
    };
    const bvcModel = t['bookVersionContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };

    const profileContributors =
      rpcModel && typeof rpcModel.findMany === 'function'
        ? await rpcModel.findMany({
            where: { rightsProfileId: profileId },
            include: {
              rightsComponent: true,
            },
          })
        : [];

    if (!profileContributors || profileContributors.length === 0) return;

    const seenKeys = new Set<string>();

    for (let index = 0; index < profileContributors.length; index++) {
      const pc = profileContributors[index];
      const personId = pc['personId'] as string | null;
      if (!personId) continue;

      const role = pc['role'] as string;
      const roleOtherRu = (pc['roleOtherRu'] as string) ?? null;
      const creditedName = (pc['creditedName'] as string) ?? (pc['displayName'] as string) ?? null;
      const confidence = (pc['confidence'] as string) ?? null;

      let shouldProject = false;
      let isPrimary = false;

      if (role === 'AUTHOR') {
        shouldProject = true;
        isPrimary = index === 0;
      } else if (role === 'TRANSLATOR') {
        const rc = pc['rightsComponent'] as Record<string, unknown> | null;
        const compType = rc ? (rc['componentType'] as string) || '' : '';
        const titleRu = rc ? (rc['titleRu'] as string) || '' : '';
        const creditedLang = (pc['creditedLanguage'] as string) || null;

        if (creditedLang) {
          shouldProject = creditedLang.toLowerCase() === versionLanguage.toLowerCase();
        } else if (compType === 'TEXT_TRANSLATION') {
          shouldProject =
            versionLanguage !== originalLanguage ||
            titleRu.toLowerCase().includes(versionLanguage.toLowerCase());
        } else {
          shouldProject = versionLanguage !== originalLanguage;
        }
      } else if (role === 'NARRATOR') {
        const typeLower = versionType ? versionType.toLowerCase() : '';
        shouldProject = typeLower === 'audio' || typeLower === 'audiobook';
      } else {
        shouldProject = true;
      }

      if (!shouldProject) continue;

      const dedupeKey = `${versionId}:${personId}:${role}:${creditedName || ''}`;
      if (seenKeys.has(dedupeKey)) continue;
      seenKeys.add(dedupeKey);

      await bvcModel.create({
        data: {
          bookVersionId: versionId,
          personId,
          role,
          roleOtherRu,
          displayOrder: index,
          isPrimary,
          creditedName,
          creditedLanguage: versionLanguage,
          confidence,
        },
      });
    }
  }
}
