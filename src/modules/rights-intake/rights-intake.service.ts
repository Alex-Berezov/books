import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, RightsIntakeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRightsIntakeDto } from './dto/create-rights-intake.dto';
import { UpdateRightsIntakeDto } from './dto/update-rights-intake.dto';
import { ListRightsIntakesDto } from './dto/list-rights-intakes.dto';
import { deriveSourceFromUrl, isSameLanguage } from './rights-intake-source-url.util';

/**
 * Manual (Phase 1) status transitions.
 *
 * Deliberately `Partial`: a status the editor may never set by hand is simply absent, which the
 * lookup reads as "no manual transition out of here". A full `Record` would have to name every
 * value the generated Prisma client knows, and that client is regenerated only on the VPS — so a
 * status added by a later phase (`LAWYER_REVIEW_REQUIRED`, Phase 19) would break the build on CI
 * while still compiling locally.
 */
const ALLOWED_PHASE1_TRANSITIONS: Partial<Record<RightsIntakeStatus, RightsIntakeStatus[]>> = {
  [RightsIntakeStatus.DRAFT]: [RightsIntakeStatus.READY_FOR_AGENT, RightsIntakeStatus.ARCHIVED],
  [RightsIntakeStatus.READY_FOR_AGENT]: [RightsIntakeStatus.DRAFT, RightsIntakeStatus.ARCHIVED],
  [RightsIntakeStatus.REVIEW_IMPORTED]: [],
  [RightsIntakeStatus.HUMAN_REVIEW_REQUIRED]: [],
  [RightsIntakeStatus.APPROVED]: [],
  [RightsIntakeStatus.REJECTED]: [],
  [RightsIntakeStatus.BOOK_CREATED]: [],
  [RightsIntakeStatus.ARCHIVED]: [],
};

const FORBIDDEN_MANUAL_STATUSES = new Set<RightsIntakeStatus>([
  RightsIntakeStatus.REVIEW_IMPORTED,
  RightsIntakeStatus.HUMAN_REVIEW_REQUIRED,
  RightsIntakeStatus.APPROVED,
  RightsIntakeStatus.REJECTED,
  RightsIntakeStatus.BOOK_CREATED,
  // Phase 19: set only by the lawyer workflow. The literal is cast because the generated client
  // does not know the value until `prisma generate` runs on the VPS.
  'LAWYER_REVIEW_REQUIRED' as RightsIntakeStatus,
]);

@Injectable()
export class RightsIntakeService {
  constructor(private readonly prisma: PrismaService) {}

  async list(dto: ListRightsIntakesDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (dto.status) {
      where['workflowStatus'] = dto.status;
    } else {
      where['workflowStatus'] = { not: 'ARCHIVED' };
    }
    if (dto.sourceProvider) {
      where['sourceProvider'] = dto.sourceProvider;
    }
    if (dto.targetLanguage) {
      where['targetLanguages'] = { array_contains: [dto.targetLanguage] };
    }
    if (dto.attentionOnly) {
      where['OR'] = [
        {
          workflowStatus: {
            in: ['DRAFT', 'READY_FOR_AGENT', 'REVIEW_IMPORTED', 'HUMAN_REVIEW_REQUIRED'],
          },
        },
        { workflowStatus: 'APPROVED', createdBookId: null },
      ];
    }
    if (dto.q) {
      const qCondition = [
        { candidateTitle: { contains: dto.q, mode: 'insensitive' } },
        { candidateAuthor: { contains: dto.q, mode: 'insensitive' } },
        { originalTitle: { contains: dto.q, mode: 'insensitive' } },
        { sourceExternalId: { contains: dto.q, mode: 'insensitive' } },
        { sourceUrl: { contains: dto.q, mode: 'insensitive' } },
      ];
      if (where['OR']) {
        where['AND'] = [{ OR: where['OR'] }, { OR: qCondition }];
        delete where['OR'];
      } else {
        where['OR'] = qCondition;
      }
    }

    const [total, rawItems] = await this.prisma.$transaction([
      this.prisma.rightsIntake.count({ where }),
      this.prisma.rightsIntake.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: dto.includeSummary
          ? {
              reviewImports: {
                where: { isCurrent: true },
                take: 1,
                select: {
                  id: true,
                  importStatus: true,
                  isCurrent: true,
                  validationErrors: true,
                  validationWarnings: true,
                  createdAt: true,
                },
              },
              rightsProfiles: {
                where: { isCurrent: true },
                take: 1,
                include: {
                  territoryDecisions: true,
                  actions: true,
                },
              },
            }
          : undefined,
      }),
    ]);

    const items = rawItems.map((item: Record<string, unknown>) => {
      if (!dto.includeSummary) return item;

      const reviewImports =
        (item['reviewImports'] as Array<{
          id: string;
          importStatus: string;
          isCurrent: boolean;
          validationErrors: unknown;
          validationWarnings: unknown;
          createdAt: Date;
        }>) || [];

      const rightsProfiles =
        (item['rightsProfiles'] as Array<{
          id: string;
          status: string;
          overallStatus: string;
          publicationGate: string;
          confidence: string;
          territoryDecisions: Array<{
            finalStatus: string;
            accessPolicy: string;
            geoBlockRequired: boolean;
          }>;
          actions: Array<{
            isBlocking: boolean;
            status: string;
          }>;
        }>) || [];

      const currentImport = reviewImports[0] || null;
      const currentProfile = rightsProfiles[0] || null;

      const intakeFields = { ...item };
      delete intakeFields['reviewImports'];
      delete intakeFields['rightsProfiles'];

      const valErrors = Array.isArray(currentImport?.validationErrors)
        ? currentImport.validationErrors
        : [];
      const valWarnings = Array.isArray(currentImport?.validationWarnings)
        ? currentImport.validationWarnings
        : [];

      const territoryDecisions = currentProfile?.territoryDecisions || [];
      const actions = currentProfile?.actions || [];

      return {
        ...intakeFields,
        currentReviewImport: currentImport
          ? {
              id: currentImport.id,
              importStatus: currentImport.importStatus,
              isCurrent: currentImport.isCurrent,
              validationErrorsCount: valErrors.length,
              validationWarningsCount: valWarnings.length,
              createdAt: currentImport.createdAt,
            }
          : null,
        currentRightsProfile: currentProfile
          ? {
              id: currentProfile.id,
              status: currentProfile.status,
              overallStatus: currentProfile.overallStatus,
              publicationGate: currentProfile.publicationGate,
              confidence: currentProfile.confidence,
              blockedCountriesCount: territoryDecisions.filter(
                (t) => t.finalStatus === 'BLOCKED' || t.accessPolicy === 'BLOCK',
              ).length,
              licenseRequiredCountriesCount: territoryDecisions.filter(
                (t) => t.finalStatus === 'LICENSE_REQUIRED',
              ).length,
              geoBlockRequiredCount: territoryDecisions.filter((t) => t.geoBlockRequired).length,
              blockingActionsCount: actions.filter(
                (a) => a.isBlocking && a.status !== 'COMPLETED' && a.status !== 'WAIVED',
              ).length,
            }
          : null,
      };
    });

    return {
      items,
      total,
      page,
      limit,
    };
  }

  async create(dto: CreateRightsIntakeDto, userId: string) {
    const derived = deriveSourceFromUrl(dto.sourceUrl);
    const sourceProvider =
      dto.sourceProvider && dto.sourceProvider !== 'UNKNOWN'
        ? dto.sourceProvider
        : (derived?.provider ?? 'UNKNOWN');
    const sourceExternalId = dto.sourceExternalId ?? derived?.externalId ?? null;
    const sourceTextType =
      dto.sourceTextType && dto.sourceTextType !== 'UNKNOWN'
        ? dto.sourceTextType
        : derived && isSameLanguage(dto.sourceLanguage, dto.originalLanguage)
          ? 'ORIGINAL_TEXT'
          : 'UNKNOWN';

    return this.prisma.rightsIntake.create({
      data: {
        candidateTitle: dto.candidateTitle,
        candidateAuthor: dto.candidateAuthor,
        originalTitle: dto.originalTitle ?? null,
        originalLanguage: dto.originalLanguage ?? null,
        authorBirthYear: dto.authorBirthYear ?? null,
        authorDeathYear: dto.authorDeathYear ?? null,
        sourceProvider,
        sourceExternalId,
        sourceUrl: dto.sourceUrl ?? null,
        sourceTitle: dto.sourceTitle ?? null,
        sourceLanguage: dto.sourceLanguage ?? null,
        sourceTextType,
        targetLanguages: dto.targetLanguages as Prisma.InputJsonValue,
        targetCountryCodes: dto.targetCountryCodes as Prisma.InputJsonValue,
        plannedContentTypes: dto.plannedContentTypes as Prisma.InputJsonValue,
        plannedComponents: (dto.plannedComponents ?? null) as Prisma.InputJsonValue,
        notesRu: dto.notesRu ?? null,
        workflowStatus: 'DRAFT',
        createdByUserId: userId,
      },
    });
  }

  async getById(id: string) {
    const intake = await this.prisma.rightsIntake.findUnique({ where: { id } });
    if (!intake) {
      throw new NotFoundException(`Rights intake with ID '${id}' not found`);
    }
    return intake;
  }

  async update(id: string, dto: UpdateRightsIntakeDto) {
    const intake = await this.getById(id);

    if (intake.workflowStatus === 'BOOK_CREATED' || intake.workflowStatus === 'ARCHIVED') {
      throw new BadRequestException('Cannot update intake in BOOK_CREATED or ARCHIVED status');
    }
    if (intake.workflowStatus === 'APPROVED' || intake.workflowStatus === 'REJECTED') {
      throw new BadRequestException('Cannot update intake in APPROVED or REJECTED status');
    }

    const data: Record<string, unknown> = {};
    if (dto.candidateTitle !== undefined) data['candidateTitle'] = dto.candidateTitle;
    if (dto.candidateAuthor !== undefined) data['candidateAuthor'] = dto.candidateAuthor;
    if (dto.originalTitle !== undefined) data['originalTitle'] = dto.originalTitle;
    if (dto.originalLanguage !== undefined) data['originalLanguage'] = dto.originalLanguage;
    if (dto.authorBirthYear !== undefined) data['authorBirthYear'] = dto.authorBirthYear;
    if (dto.authorDeathYear !== undefined) data['authorDeathYear'] = dto.authorDeathYear;
    if (dto.sourceProvider !== undefined) data['sourceProvider'] = dto.sourceProvider;
    if (dto.sourceExternalId !== undefined) data['sourceExternalId'] = dto.sourceExternalId;
    if (dto.sourceUrl !== undefined) data['sourceUrl'] = dto.sourceUrl;
    if (dto.sourceTitle !== undefined) data['sourceTitle'] = dto.sourceTitle;
    if (dto.sourceLanguage !== undefined) data['sourceLanguage'] = dto.sourceLanguage;
    if (dto.sourceTextType !== undefined) data['sourceTextType'] = dto.sourceTextType;
    if (dto.targetLanguages !== undefined)
      data['targetLanguages'] = dto.targetLanguages as Prisma.InputJsonValue;
    if (dto.targetCountryCodes !== undefined)
      data['targetCountryCodes'] = dto.targetCountryCodes as Prisma.InputJsonValue;
    if (dto.plannedContentTypes !== undefined)
      data['plannedContentTypes'] = dto.plannedContentTypes as Prisma.InputJsonValue;
    if (dto.plannedComponents !== undefined)
      data['plannedComponents'] = dto.plannedComponents as Prisma.InputJsonValue;
    if (dto.notesRu !== undefined) data['notesRu'] = dto.notesRu;

    this.fillSourceGapsFromUrl(intake, dto, data);

    return this.prisma.rightsIntake.update({
      where: { id },
      data,
    });
  }

  /**
   * WP-F.1: ссылка на Gutenberg заполняет только пробелы источника. Явно выбранные редактором
   * провайдер, ID и тип текста приложение не переписывает: вывод из URL — его собственная
   * догадка, а не установленный человеком факт.
   */
  private fillSourceGapsFromUrl(
    intake: {
      sourceProvider: string;
      sourceExternalId: string | null;
      sourceUrl: string | null;
      sourceLanguage: string | null;
      originalLanguage: string | null;
      sourceTextType: string;
    },
    dto: UpdateRightsIntakeDto,
    data: Record<string, unknown>,
  ): void {
    const derived = deriveSourceFromUrl(
      dto.sourceUrl !== undefined ? dto.sourceUrl : intake.sourceUrl,
    );
    if (!derived) {
      return;
    }

    const provider = dto.sourceProvider !== undefined ? dto.sourceProvider : intake.sourceProvider;
    if (!provider || provider === 'UNKNOWN') {
      data['sourceProvider'] = derived.provider;
    }

    const externalId =
      dto.sourceExternalId !== undefined ? dto.sourceExternalId : intake.sourceExternalId;
    if (derived.externalId && (externalId === null || externalId === '')) {
      data['sourceExternalId'] = derived.externalId;
    }

    const textType = dto.sourceTextType !== undefined ? dto.sourceTextType : intake.sourceTextType;
    if (!textType || textType === 'UNKNOWN') {
      const sourceLanguage =
        dto.sourceLanguage !== undefined ? dto.sourceLanguage : intake.sourceLanguage;
      const originalLanguage =
        dto.originalLanguage !== undefined ? dto.originalLanguage : intake.originalLanguage;
      if (isSameLanguage(sourceLanguage, originalLanguage)) {
        data['sourceTextType'] = 'ORIGINAL_TEXT';
      }
    }
  }

  async changeStatus(id: string, newStatus: RightsIntakeStatus) {
    const intake = await this.getById(id);

    const forbiddenStatuses = Array.from(FORBIDDEN_MANUAL_STATUSES);
    if (forbiddenStatuses.includes(newStatus)) {
      throw new BadRequestException(
        `Status '${newStatus}' cannot be set manually. It is reserved for future phases.`,
      );
    }

    const allowed = ALLOWED_PHASE1_TRANSITIONS[intake.workflowStatus] ?? [];
    if (!allowed.includes(newStatus)) {
      throw new BadRequestException(
        `Cannot transition from '${intake.workflowStatus}' to '${newStatus}'. ` +
          `Allowed transitions: ${allowed.join(', ') || 'none'}.`,
      );
    }

    return this.prisma.rightsIntake.update({
      where: { id },
      data: { workflowStatus: newStatus },
    });
  }

  /**
   * WP-L.3: `force` снимает ограничение по статусу и доступен только администратору
   * (`DELETE :id/force`). Ошибочно заведённую или тестовую проверку невозможно было убрать из
   * списка, как только она уходила дальше `READY_FOR_AGENT`: разрешённых переходов из
   * `REVIEW_IMPORTED`, `APPROVED` и `BOOK_CREATED` нет вовсе, и запись оставалась в работе навсегда.
   *
   * Физического удаления по-прежнему нет (ADR-009): это тот же перевод в `ARCHIVED` с `archivedAt`,
   * юридический след цепочки `intake → import → review → approval → снимок на версии` остаётся
   * целым. Публикация уже созданной книги не затрагивается: гейт читает у интейка только
   * `targetCountryCodes` и никогда `workflowStatus`.
   */
  async archive(id: string, options: { force?: boolean } = {}) {
    const intake = await this.getById(id);
    if (intake.workflowStatus === 'ARCHIVED') {
      throw new BadRequestException('Rights intake is already archived');
    }
    if (
      !options.force &&
      intake.workflowStatus !== 'DRAFT' &&
      intake.workflowStatus !== 'READY_FOR_AGENT'
    ) {
      throw new BadRequestException(
        `Cannot archive intake with status '${intake.workflowStatus}'. Only DRAFT or READY_FOR_AGENT can be archived.`,
      );
    }

    return this.prisma.rightsIntake.update({
      where: { id },
      data: {
        workflowStatus: 'ARCHIVED',
        archivedAt: new Date(),
      },
    });
  }
}
