import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma, RightsIntakeStatus } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRightsIntakeDto } from './dto/create-rights-intake.dto';
import { UpdateRightsIntakeDto } from './dto/update-rights-intake.dto';
import { ListRightsIntakesDto } from './dto/list-rights-intakes.dto';

const ALLOWED_PHASE1_TRANSITIONS: Record<RightsIntakeStatus, RightsIntakeStatus[]> = {
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
    if (dto.q) {
      where['OR'] = [
        { candidateTitle: { contains: dto.q, mode: 'insensitive' } },
        { candidateAuthor: { contains: dto.q, mode: 'insensitive' } },
        { originalTitle: { contains: dto.q, mode: 'insensitive' } },
        { sourceExternalId: { contains: dto.q, mode: 'insensitive' } },
        { sourceUrl: { contains: dto.q, mode: 'insensitive' } },
      ];
    }

    const [total, items] = await this.prisma.$transaction([
      this.prisma.rightsIntake.count({ where }),
      this.prisma.rightsIntake.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      items,
      total,
      page,
      limit,
    };
  }

  async create(dto: CreateRightsIntakeDto, userId: string) {
    return this.prisma.rightsIntake.create({
      data: {
        candidateTitle: dto.candidateTitle,
        candidateAuthor: dto.candidateAuthor,
        originalTitle: dto.originalTitle ?? null,
        originalLanguage: dto.originalLanguage ?? null,
        authorBirthYear: dto.authorBirthYear ?? null,
        authorDeathYear: dto.authorDeathYear ?? null,
        sourceProvider: dto.sourceProvider ?? 'UNKNOWN',
        sourceExternalId: dto.sourceExternalId ?? null,
        sourceUrl: dto.sourceUrl ?? null,
        sourceTitle: dto.sourceTitle ?? null,
        sourceLanguage: dto.sourceLanguage ?? null,
        sourceTextType: dto.sourceTextType ?? 'UNKNOWN',
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

    return this.prisma.rightsIntake.update({
      where: { id },
      data,
    });
  }

  async changeStatus(id: string, newStatus: RightsIntakeStatus) {
    const intake = await this.getById(id);

    const forbiddenStatuses = Array.from(FORBIDDEN_MANUAL_STATUSES);
    if (forbiddenStatuses.includes(newStatus)) {
      throw new BadRequestException(
        `Status '${newStatus}' cannot be set manually. It is reserved for future phases.`,
      );
    }

    const allowed = ALLOWED_PHASE1_TRANSITIONS[intake.workflowStatus];
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

  async archive(id: string) {
    const intake = await this.getById(id);
    if (intake.workflowStatus === 'ARCHIVED') {
      throw new BadRequestException('Rights intake is already archived');
    }
    if (intake.workflowStatus !== 'DRAFT' && intake.workflowStatus !== 'READY_FOR_AGENT') {
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
