import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsLawyerReviewService } from './rights-lawyer-review.service';
import { RightsLegalOpinionService } from './rights-legal-opinion.service';
import { AssignLawyerReviewDto } from './dto/assign-lawyer-review.dto';
import { CreateLegalOpinionDto } from './dto/create-legal-opinion.dto';
import { CreateConditionDto, DecideLawyerReviewDto } from './dto/decide-lawyer-review.dto';
import { ListLawyerReviewsDto } from './dto/list-lawyer-reviews.dto';
import {
  AddLawyerReviewNoteDto,
  ArchiveOpinionDto,
  SatisfyConditionDto,
  WaiveConditionDto,
  WithdrawLawyerReviewDto,
} from './dto/reason.dto';
import { RequestLawyerReviewDto, RequireLawyerReviewDto } from './dto/request-lawyer-review.dto';
import type {
  LawyerReviewDetailDto,
  LawyerReviewListResponseDto,
  LegalOpinionDto,
} from './dto/lawyer-review-response.dto';
import type { RiskAssessmentSnapshotDto } from './dto/risk-assessment-response.dto';
import type {
  LawyerExpiryScanResultDto,
  VersionLawyerReviewDto,
} from './dto/version-lawyer-review-response.dto';

/**
 * Static segments are declared before parametric ones (`lawyer-reviews/expiry-scan` before
 * `lawyer-reviews/:id`) so Nest never matches `expiry-scan` as a review id.
 */
@ApiTags('rights-lawyer-reviews')
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager, Role.Lawyer)
@ApiBearerAuth()
export class RightsLawyerReviewController {
  constructor(
    private readonly reviews: RightsLawyerReviewService,
    private readonly opinions: RightsLegalOpinionService,
  ) {}

  @Get('admin/rights/lawyer-reviews')
  @ApiOperation({ summary: 'Legal review inbox' })
  list(
    @Query() query: ListLawyerReviewsDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewListResponseDto> {
    return this.reviews.list(query, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Request a legal review' })
  request(
    @Body() dto: RequestLawyerReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.request(dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/expiry-scan')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Materialise expired legal opinions (admin only)' })
  runExpiryScan(@Req() req: { user: { userId: string } }): Promise<LawyerExpiryScanResultDto> {
    return this.reviews.runExpiryScan(req.user.userId);
  }

  @Get('admin/rights/lawyer-reviews/:id')
  @ApiOperation({ summary: 'Legal review details, conditions, opinions and timeline' })
  getById(@Param('id') id: string): Promise<LawyerReviewDetailDto> {
    return this.reviews.getById(id);
  }

  @Post('admin/rights/lawyer-reviews/:id/assign')
  @ApiOperation({ summary: 'Assign a lawyer (a lawyer may only assign themselves)' })
  assign(
    @Param('id') id: string,
    @Body() dto: AssignLawyerReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.assign(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/start')
  @Roles(Role.Admin, Role.Lawyer)
  @ApiOperation({ summary: 'Take a legal review into work' })
  start(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.start(id, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/decide')
  @Roles(Role.Admin, Role.Lawyer)
  @ApiOperation({ summary: 'Record the lawyer verdict' })
  decide(
    @Param('id') id: string,
    @Body() dto: DecideLawyerReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.decide(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/withdraw')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Withdraw a legal review, reason required' })
  withdraw(
    @Param('id') id: string,
    @Body() dto: WithdrawLawyerReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.withdraw(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/reopen')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Reopen a closed legal review (admin only)' })
  reopen(
    @Param('id') id: string,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.reopen(id, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/notes')
  @ApiOperation({ summary: 'Append a note to the timeline' })
  addNote(
    @Param('id') id: string,
    @Body() dto: AddLawyerReviewNoteDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.addNote(id, dto, req.user.userId);
  }

  @Get('admin/rights/lawyer-reviews/:id/opinions')
  @ApiOperation({ summary: 'Legal opinions attached to a review' })
  listOpinions(@Param('id') id: string): Promise<LegalOpinionDto[]> {
    return this.opinions.list(id);
  }

  @Post('admin/rights/lawyer-reviews/:id/opinions')
  @Roles(Role.Admin, Role.Lawyer)
  @ApiOperation({ summary: 'Attach a legal opinion; creates LEGAL_OPINION evidence' })
  attachOpinion(
    @Param('id') id: string,
    @Body() dto: CreateLegalOpinionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalOpinionDto> {
    return this.opinions.attach(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/opinions/:opinionId/archive')
  @Roles(Role.Admin, Role.Lawyer)
  @ApiOperation({ summary: 'Archive a legal opinion (soft), reason required' })
  archiveOpinion(
    @Param('id') id: string,
    @Param('opinionId') opinionId: string,
    @Body() dto: ArchiveOpinionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LegalOpinionDto> {
    return this.opinions.archive(id, opinionId, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/conditions')
  @Roles(Role.Admin, Role.Lawyer)
  @ApiOperation({ summary: 'Add a mandatory condition' })
  addCondition(
    @Param('id') id: string,
    @Body() dto: CreateConditionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.addCondition(id, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/conditions/:conditionId/satisfy')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Mark a condition as satisfied' })
  satisfyCondition(
    @Param('id') id: string,
    @Param('conditionId') conditionId: string,
    @Body() dto: SatisfyConditionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.satisfyCondition(id, conditionId, dto, req.user.userId);
  }

  @Post('admin/rights/lawyer-reviews/:id/conditions/:conditionId/waive')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Waive a condition, reason required (admin only)' })
  waiveCondition(
    @Param('id') id: string,
    @Param('conditionId') conditionId: string,
    @Body() dto: WaiveConditionDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.waiveCondition(id, conditionId, dto, req.user.userId);
  }

  @Get('admin/rights/intakes/:id/lawyer-reviews')
  @ApiOperation({ summary: 'Legal reviews of an intake' })
  listByIntake(
    @Param('id') id: string,
    @Query() query: ListLawyerReviewsDto,
  ): Promise<LawyerReviewListResponseDto> {
    return this.reviews.listByIntake(id, query);
  }

  @Get('admin/rights/profiles/:id/risk-assessment')
  @ApiOperation({ summary: 'Risk assessment of a rights profile; refreshes the snapshot' })
  getRiskAssessment(@Param('id') id: string): Promise<RiskAssessmentSnapshotDto> {
    return this.reviews.getRiskAssessmentForProfile(id);
  }

  @Post('admin/rights/profiles/:id/require-lawyer-review')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Force a legal review for a rights profile' })
  requireForProfile(
    @Param('id') id: string,
    @Body() dto: RequireLawyerReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<LawyerReviewDetailDto> {
    return this.reviews.requireForProfile(id, dto, req.user.userId);
  }

  @Get('admin/versions/:id/lawyer-review')
  @ApiOperation({ summary: 'Legal state of a book version' })
  getVersionLawyerReview(@Param('id') id: string): Promise<VersionLawyerReviewDto> {
    return this.reviews.getVersionLawyerReview(id);
  }
}
