import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  LAWYER_ERROR_CODES,
  LAWYER_LIST_DEFAULT_LIMIT,
  LAWYER_LIST_MAX_LIMIT,
  LAWYER_MIN_REASON_LENGTH,
  LAWYER_REVIEW_OPEN_STATUSES,
} from './rights-lawyer.constants';
import { lawyerError } from './rights-lawyer.errors';
import {
  RightsLawyerType,
  toStringArray,
  type LawyerDatabaseClient,
  type RightsLawyerDelegate,
  type RightsLawyerRecord,
} from './rights-lawyer-interface';
import type { CreateLawyerDto } from './dto/create-lawyer.dto';
import type { LawyerDetailDto, LawyerDto, LawyersListResponseDto } from './dto/lawyer-response.dto';
import type { ListLawyersDto } from './dto/list-lawyers.dto';
import type { DeactivateLawyerDto } from './dto/reason.dto';
import type { UpdateLawyerDto } from './dto/update-lawyer.dto';

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;
const LAWYER_ROLE_NAME = 'lawyer';

/**
 * Directory of lawyers and legal organisations. There is no physical delete: a lawyer is
 * deactivated, and every opinion they already issued keeps its force.
 */
@Injectable()
export class RightsLawyerService {
  constructor(private readonly prisma: PrismaService) {}

  private getDatabase(): LawyerDatabaseClient {
    return this.prisma as unknown as LawyerDatabaseClient;
  }

  private get delegate(): RightsLawyerDelegate {
    return this.getDatabase().rightsLawyer;
  }

  async list(query: ListLawyersDto): Promise<LawyersListResponseDto> {
    const page = query.page && query.page > 0 ? query.page : 1;
    const limit =
      query.limit && query.limit > 0
        ? Math.min(query.limit, LAWYER_LIST_MAX_LIMIT)
        : LAWYER_LIST_DEFAULT_LIMIT;

    const where: Record<string, unknown> = {};
    if (query.lawyerType) where['lawyerType'] = query.lawyerType;
    if (query.isActive !== undefined) where['isActive'] = query.isActive;
    if (query.q) {
      const contains = { contains: query.q, mode: 'insensitive' };
      where['OR'] = [
        { fullName: contains },
        { organization: contains },
        { email: contains },
        { barId: contains },
      ];
    }

    // `jurisdictionCodes` is a Json column: it cannot be filtered through the dynamic delegate,
    // so the predicate runs after the query and before paging.
    const jurisdiction = query.jurisdictionCode?.toUpperCase();
    const rows = await this.delegate.findMany({
      where,
      orderBy: [{ isActive: 'desc' }, { fullName: 'asc' }],
      include: this.userInclude(),
    });

    const filtered = jurisdiction
      ? rows.filter((row) => toStringArray(row.jurisdictionCodes).includes(jurisdiction))
      : rows;

    const start = (page - 1) * limit;
    return {
      items: filtered.slice(start, start + limit).map((row) => this.toDto(row)),
      total: filtered.length,
      page,
      limit,
    };
  }

  async getById(id: string): Promise<LawyerDetailDto> {
    const lawyer = await this.requireLawyer(id);
    const database = this.getDatabase();

    const [openReviewsCount, decidedReviewsCount, opinionsCount] = await Promise.all([
      database.rightsLawyerReview.count({
        where: { assignedLawyerId: id, status: { in: [...LAWYER_REVIEW_OPEN_STATUSES] } },
      }),
      database.rightsLawyerReview.count({ where: { decidedLawyerId: id } }),
      database.rightsLegalOpinion.count({ where: { lawyerId: id } }),
    ]);

    return { ...this.toDto(lawyer), openReviewsCount, decidedReviewsCount, opinionsCount };
  }

  async create(dto: CreateLawyerDto, userId: string): Promise<LawyerDetailDto> {
    const jurisdictionCodes = this.normaliseJurisdictions(dto.jurisdictionCodes);
    await this.assertUserLinkable(dto.userId ?? null, null);

    const created = await this.delegate.create({
      data: {
        fullName: dto.fullName.trim(),
        lawyerType: dto.lawyerType ?? RightsLawyerType.EXTERNAL_COUNSEL,
        organization: dto.organization ?? null,
        barId: dto.barId ?? null,
        email: dto.email ?? null,
        phone: dto.phone ?? null,
        jurisdictionCodes,
        specializationRu: dto.specializationRu ?? null,
        notesRu: dto.notesRu ?? null,
        userId: dto.userId ?? null,
        createdByUserId: userId,
      },
    });

    return this.getById(created.id);
  }

  async update(id: string, dto: UpdateLawyerDto): Promise<LawyerDetailDto> {
    const existing = await this.requireLawyer(id);

    if (dto.userId !== undefined) {
      await this.assertUserLinkable(dto.userId, existing.id);
    }

    const data: Record<string, unknown> = {};
    if (dto.fullName !== undefined) data['fullName'] = dto.fullName.trim();
    if (dto.lawyerType !== undefined) data['lawyerType'] = dto.lawyerType;
    if (dto.organization !== undefined) data['organization'] = dto.organization ?? null;
    if (dto.barId !== undefined) data['barId'] = dto.barId ?? null;
    if (dto.email !== undefined) data['email'] = dto.email ?? null;
    if (dto.phone !== undefined) data['phone'] = dto.phone ?? null;
    if (dto.specializationRu !== undefined) data['specializationRu'] = dto.specializationRu ?? null;
    if (dto.notesRu !== undefined) data['notesRu'] = dto.notesRu ?? null;
    if (dto.userId !== undefined) data['userId'] = dto.userId ?? null;
    if (dto.jurisdictionCodes !== undefined) {
      data['jurisdictionCodes'] = this.normaliseJurisdictions(dto.jurisdictionCodes);
    }

    await this.delegate.update({ where: { id }, data });
    return this.getById(id);
  }

  async deactivate(id: string, dto: DeactivateLawyerDto, userId: string): Promise<LawyerDetailDto> {
    await this.requireLawyer(id);
    this.assertReason(dto.reasonRu);

    await this.delegate.update({
      where: { id },
      data: {
        isActive: false,
        deactivatedAt: new Date(),
        deactivatedByUserId: userId,
        deactivateReasonRu: dto.reasonRu,
      },
    });

    return this.getById(id);
  }

  /**
   * Возврат юриста в строй. Аудит деактивации (`deactivatedBy*`) очищается — отдельных колонок
   * «кто активировал» в справочнике нет, поэтому и параметр пользователя здесь не нужен.
   */
  async activate(id: string): Promise<LawyerDetailDto> {
    await this.requireLawyer(id);

    await this.delegate.update({
      where: { id },
      data: {
        isActive: true,
        deactivatedAt: null,
        deactivatedByUserId: null,
        deactivateReasonRu: null,
      },
    });

    return this.getById(id);
  }

  /** The lawyer linked to a platform user, or `null` when there is no link. */
  async findByUserId(userId: string): Promise<RightsLawyerRecord | null> {
    return this.delegate.findFirst({ where: { userId } });
  }

  /** Shared by the review and opinion services: an assignable lawyer must exist and be active. */
  async requireActiveLawyer(id: string): Promise<RightsLawyerRecord> {
    const lawyer = await this.requireLawyer(id);
    if (!lawyer.isActive) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_INACTIVE, { lawyerId: id });
    }
    return lawyer;
  }

  async requireLawyer(id: string): Promise<RightsLawyerRecord> {
    const lawyer = await this.delegate.findUnique({ where: { id }, include: this.userInclude() });
    if (!lawyer) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_NOT_FOUND, {
        lawyerId: id,
      });
    }
    return lawyer;
  }

  toDto(record: RightsLawyerRecord): LawyerDto {
    const roles = record.user?.roles ?? [];
    return {
      id: record.id,
      fullName: record.fullName,
      lawyerType: record.lawyerType,
      organization: record.organization,
      barId: record.barId,
      email: record.email,
      phone: record.phone,
      jurisdictionCodes: toStringArray(record.jurisdictionCodes),
      specializationRu: record.specializationRu,
      notesRu: record.notesRu,
      userId: record.userId,
      userEmail: record.user?.email ?? null,
      hasLawyerRole: roles.some((entry) => entry.role.name === LAWYER_ROLE_NAME),
      isActive: record.isActive,
      deactivatedAt: record.deactivatedAt ? new Date(record.deactivatedAt).toISOString() : null,
      deactivateReasonRu: record.deactivateReasonRu,
      createdAt: new Date(record.createdAt).toISOString(),
      updatedAt: new Date(record.updatedAt).toISOString(),
    };
  }

  private userInclude(): Record<string, unknown> {
    return {
      user: { select: { id: true, name: true, email: true, roles: { include: { role: true } } } },
    };
  }

  private normaliseJurisdictions(codes: string[] | undefined): string[] {
    if (!codes) return [];
    const normalised = codes.map((code) => code.trim().toUpperCase()).filter(Boolean);
    const invalid = normalised.filter((code) => !COUNTRY_CODE_PATTERN.test(code));
    if (invalid.length > 0) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_INVALID_JURISDICTION, {
        invalid,
      });
    }
    return [...new Set(normalised)];
  }

  /**
   * The link to a platform user is unique. Having the `lawyer` role is NOT required — roles are
   * granted separately in the Users section — but the UI warns when it is missing.
   */
  private async assertUserLinkable(userId: string | null, selfId: string | null): Promise<void> {
    if (!userId) return;

    const user = await this.getDatabase().user.findUnique({ where: { id: userId } });
    if (!user) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_USER_NOT_FOUND, { userId });
    }

    const linked = await this.delegate.findFirst({ where: { userId } });
    if (linked && linked.id !== selfId) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_USER_ALREADY_LINKED, {
        userId,
        lawyerId: linked.id,
      });
    }
  }

  private assertReason(reason: string): void {
    if (reason.trim().length < LAWYER_MIN_REASON_LENGTH) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_REASON_TOO_SHORT, {
        minLength: LAWYER_MIN_REASON_LENGTH,
      });
    }
  }
}
