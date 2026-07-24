import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { RightsIntakeService } from './rights-intake.service';
import { RightsIntakeManifestService } from './rights-intake-manifest.service';
import { RightsApprovalService } from './rights-approval.service';
import { RightsBookCreationService } from './rights-book-creation.service';
import { CreateRightsIntakeDto } from './dto/create-rights-intake.dto';
import { UpdateRightsIntakeDto } from './dto/update-rights-intake.dto';
import { ListRightsIntakesDto } from './dto/list-rights-intakes.dto';
import { ChangeRightsIntakeStatusDto } from './dto/change-rights-intake-status.dto';
import { ApproveRightsReviewDto } from './dto/approve-rights-review.dto';
import { RejectRightsReviewDto } from './dto/reject-rights-review.dto';
import { RightsReviewApprovalDto } from './dto/rights-review-approval.dto';
import { RightsProfileDetailDto } from './dto/rights-profile-response.dto';
import { CreateBookFromClearanceDto } from './dto/create-book-from-clearance.dto';
import { CreateBookFromClearanceResponseDto } from './dto/create-book-from-clearance-response.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';

@ApiTags('rights-intakes')
@Controller('admin/rights/intakes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
export class RightsIntakeController {
  constructor(
    private readonly service: RightsIntakeService,
    private readonly manifestService: RightsIntakeManifestService,
    private readonly rightsApprovalService: RightsApprovalService,
    private readonly rightsBookCreationService: RightsBookCreationService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List rights intakes' })
  list(@Query() dto: ListRightsIntakesDto) {
    return this.service.list(dto);
  }

  @Post()
  @ApiOperation({ summary: 'Create rights intake' })
  create(@Body() dto: CreateRightsIntakeDto, @Req() req: { user: { userId: string } }) {
    return this.service.create(dto, req.user.userId);
  }

  @Get(':id/agent-manifest')
  @ApiOperation({ summary: 'Export agent manifest for external ChatGPT-based rights check' })
  agentManifest(@Param('id') id: string) {
    return this.manifestService.generate(id);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get rights intake by ID' })
  getById(@Param('id') id: string) {
    return this.service.getById(id);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update rights intake' })
  update(@Param('id') id: string, @Body() dto: UpdateRightsIntakeDto) {
    return this.service.update(id, dto);
  }

  @Patch(':id/status')
  @ApiOperation({ summary: 'Change rights intake status' })
  changeStatus(@Param('id') id: string, @Body() dto: ChangeRightsIntakeStatusDto) {
    return this.service.changeStatus(id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Archive rights intake (soft delete)' })
  archive(@Param('id') id: string) {
    return this.service.archive(id);
  }

  @Post(':intakeId/reviews/:reviewId/approve')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Approve a rights review (human approval)' })
  async approveReview(
    @Param('intakeId') intakeId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: ApproveRightsReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsProfileDetailDto> {
    return this.rightsApprovalService.approveReview(req.user.userId, intakeId, reviewId, dto);
  }

  @Post(':intakeId/reviews/:reviewId/reject')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Reject a rights review (human rejection)' })
  async rejectReview(
    @Param('intakeId') intakeId: string,
    @Param('reviewId') reviewId: string,
    @Body() dto: RejectRightsReviewDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RightsProfileDetailDto> {
    return this.rightsApprovalService.rejectReview(req.user.userId, intakeId, reviewId, dto);
  }

  @Get(':intakeId/approvals')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get all approvals for a rights intake' })
  async getApprovalsByIntake(
    @Param('intakeId') intakeId: string,
  ): Promise<RightsReviewApprovalDto[]> {
    return this.rightsApprovalService.getApprovalsByIntake(intakeId);
  }

  @Post(':id/create-book')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Create book from approved rights clearance' })
  async createBookFromClearance(
    @Param('id') id: string,
    @Body() dto: CreateBookFromClearanceDto,
  ): Promise<CreateBookFromClearanceResponseDto> {
    return this.rightsBookCreationService.createBookFromApprovedClearance(id, dto);
  }
}
