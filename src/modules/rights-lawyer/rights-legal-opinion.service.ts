import { HttpStatus, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsLawyerService } from './rights-lawyer.service';
import { toOpinionDto } from './rights-lawyer-review.service';
import {
  LAWYER_ERROR_CODES,
  LAWYER_OPINION_MAX_BODY_LENGTH,
  LAWYER_MIN_REASON_LENGTH,
} from './rights-lawyer.constants';
import { lawyerError } from './rights-lawyer.errors';
import {
  RightsLawyerReviewEventType,
  RightsLawyerReviewStatus,
  RightsLegalOpinionKind,
  type LawyerDatabaseClient,
  type RightsLawyerReviewRecord,
} from './rights-lawyer-interface';
import type { CreateLegalOpinionDto } from './dto/create-legal-opinion.dto';
import type { LegalOpinionDto } from './dto/lawyer-review-response.dto';
import type { ArchiveOpinionDto } from './dto/reason.dto';

/** How much of the opinion body is copied into the evidence excerpt. */
const EVIDENCE_EXCERPT_LENGTH = 2000;

/**
 * Legal opinions are documents attached to a lawyer review. Attaching one also creates the
 * matching `RightsEvidence` of type `LEGAL_OPINION`, so the opinion shows up in the evidence
 * trail of the rights profile. Opinions are never deleted — only archived (soft).
 */
@Injectable()
export class RightsLegalOpinionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly lawyers: RightsLawyerService,
  ) {}

  private getDatabase(): LawyerDatabaseClient {
    return this.prisma as unknown as LawyerDatabaseClient;
  }

  async list(reviewId: string): Promise<LegalOpinionDto[]> {
    await this.requireReview(reviewId);
    const rows = await this.getDatabase().rightsLegalOpinion.findMany({
      where: { rightsLawyerReviewId: reviewId },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((row) => toOpinionDto(row));
  }

  async attach(
    reviewId: string,
    dto: CreateLegalOpinionDto,
    userId: string,
  ): Promise<LegalOpinionDto> {
    const review = await this.requireReview(reviewId);

    if (review.status === RightsLawyerReviewStatus.WITHDRAWN) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_REVIEW_ALREADY_CLOSED, {
        status: review.status,
      });
    }

    if (dto.bodyRu.length > LAWYER_OPINION_MAX_BODY_LENGTH) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_OPINION_TOO_LARGE, {
        maxLength: LAWYER_OPINION_MAX_BODY_LENGTH,
      });
    }

    const lawyerId = dto.lawyerId ?? review.assignedLawyerId;
    if (!lawyerId) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_OPINION_LAWYER_REQUIRED);
    }
    const lawyer = await this.lawyers.requireLawyer(lawyerId);

    const database = this.getDatabase();

    // Дедупликация по документу в рамках одной проверки: повторное прикрепление того же файла
    // возвращает существующее заключение вместо создания второго.
    if (dto.documentSha256) {
      const existing = await database.rightsLegalOpinion.findFirst({
        where: { rightsLawyerReviewId: reviewId, documentSha256: dto.documentSha256 },
      });
      if (existing) {
        return toOpinionDto(existing);
      }
    }

    const now = new Date();
    const created = await database.$transaction(async (tx) => {
      // Доказательство создаётся только если у проверки известен профиль прав:
      // RightsEvidence без rightsProfileId существовать не может.
      let evidenceId: string | null = null;
      if (review.rightsProfileId) {
        const evidence = await tx.rightsEvidence.create({
          data: {
            rightsProfileId: review.rightsProfileId,
            evidenceType: 'LEGAL_OPINION',
            sourceLevel: 'SECONDARY',
            title: dto.titleRu,
            authority: lawyer.organization ?? lawyer.fullName,
            url: dto.documentUrl ?? null,
            jurisdictionCode: dto.jurisdictionCodes?.[0]?.toUpperCase() ?? null,
            accessedAt: dto.issuedAt ? new Date(dto.issuedAt) : now,
            relevantExcerpt: dto.bodyRu.slice(0, EVIDENCE_EXCERPT_LENGTH),
            summaryRu: `${dto.titleRu} — ${lawyer.fullName}`,
            // WP-9.3 (R3-08): у заключения юриста сумма документа уже приходит в DTO и
            // используется для дедупликации — но до сих пор не доходила до доказательства,
            // и именно у этих доказательств реальный файл существует чаще всего.
            fileSha256: dto.documentSha256 ?? null,
            fileName: dto.fileName ?? null,
            contentType: dto.mimeType ?? null,
          },
        });
        evidenceId = evidence.id;
      }

      const opinion = await tx.rightsLegalOpinion.create({
        data: {
          rightsLawyerReviewId: reviewId,
          kind: dto.kind ?? RightsLegalOpinionKind.EXTERNAL_COUNSEL_MEMO,
          titleRu: dto.titleRu,
          bodyRu: dto.bodyRu,
          lawyerId: lawyer.id,
          lawyerNameSnapshot: lawyer.fullName,
          documentUrl: dto.documentUrl ?? null,
          documentSha256: dto.documentSha256 ?? null,
          fileName: dto.fileName ?? null,
          mimeType: dto.mimeType ?? null,
          issuedAt: dto.issuedAt ? new Date(dto.issuedAt) : null,
          jurisdictionCodes: (dto.jurisdictionCodes ?? []).map((code) => code.trim().toUpperCase()),
          rightsEvidenceId: evidenceId,
          uploadedByUserId: userId,
        },
      });

      await tx.rightsLawyerReviewEvent.create({
        data: {
          rightsLawyerReviewId: reviewId,
          eventType: RightsLawyerReviewEventType.OPINION_ATTACHED,
          messageRu: `Прикреплено заключение «${dto.titleRu}» (${lawyer.fullName}).`,
          payload: { opinionId: opinion.id, rightsEvidenceId: evidenceId },
          createdByUserId: userId,
        },
      });

      return opinion;
    });

    return toOpinionDto(created);
  }

  /** Soft archive. The linked `RightsEvidence` stays: evidence is never deleted (Phase 4). */
  async archive(
    reviewId: string,
    opinionId: string,
    dto: ArchiveOpinionDto,
    userId: string,
  ): Promise<LegalOpinionDto> {
    await this.requireReview(reviewId);

    const database = this.getDatabase();
    const opinion = await database.rightsLegalOpinion.findUnique({ where: { id: opinionId } });
    if (!opinion || opinion.rightsLawyerReviewId !== reviewId) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_OPINION_NOT_FOUND, {
        opinionId,
      });
    }
    if (opinion.archivedAt) {
      throw lawyerError(HttpStatus.CONFLICT, LAWYER_ERROR_CODES.LAWYER_OPINION_ALREADY_ARCHIVED, {
        opinionId,
      });
    }
    if (dto.reasonRu.trim().length < LAWYER_MIN_REASON_LENGTH) {
      throw lawyerError(HttpStatus.BAD_REQUEST, LAWYER_ERROR_CODES.LAWYER_REASON_TOO_SHORT, {
        minLength: LAWYER_MIN_REASON_LENGTH,
      });
    }

    const archived = await database.$transaction(async (tx) => {
      const updated = await tx.rightsLegalOpinion.update({
        where: { id: opinionId },
        data: {
          archivedAt: new Date(),
          archivedByUserId: userId,
          archiveReasonRu: dto.reasonRu,
        },
      });

      await tx.rightsLawyerReviewEvent.create({
        data: {
          rightsLawyerReviewId: reviewId,
          eventType: RightsLawyerReviewEventType.OPINION_ARCHIVED,
          messageRu: `Заключение «${updated.titleRu}» архивировано: ${dto.reasonRu}`,
          payload: { opinionId, rightsEvidenceId: updated.rightsEvidenceId },
          createdByUserId: userId,
        },
      });

      return updated;
    });

    return toOpinionDto(archived);
  }

  private async requireReview(reviewId: string): Promise<RightsLawyerReviewRecord> {
    const review = await this.getDatabase().rightsLawyerReview.findUnique({
      where: { id: reviewId },
    });
    if (!review) {
      throw lawyerError(HttpStatus.NOT_FOUND, LAWYER_ERROR_CODES.LAWYER_REVIEW_NOT_FOUND, {
        lawyerReviewId: reviewId,
      });
    }
    return review;
  }
}
