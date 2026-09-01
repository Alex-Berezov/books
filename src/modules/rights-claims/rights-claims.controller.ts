import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { ApplyClaimBlockDto } from './dto/apply-claim-block.dto';
import { AssignRightsClaimDto } from './dto/assign-rights-claim.dto';
import { ChangeRightsClaimStatusDto } from './dto/change-rights-claim-status.dto';
import { CreateClaimAttachmentDto } from './dto/create-claim-attachment.dto';
import { CreateRightsClaimDto } from './dto/create-rights-claim.dto';
import { LiftClaimBlockDto } from './dto/lift-claim-block.dto';
import { LinkClaimComponentDto } from './dto/link-claim-component.dto';
import { QueryRightsClaimsDto } from './dto/query-rights-claims.dto';
import { RecordClaimResponseDto } from './dto/record-claim-response.dto';
import { RecordCounterNoticeDto } from './dto/record-counter-notice.dto';
import {
  ClaimMutationResultDto,
  RightsClaimAccessBlockDto,
  RightsClaimAttachmentDto,
  RightsClaimComponentDto,
  RightsClaimDetailDto,
  RightsClaimListResponseDto,
} from './dto/rights-claim-response.dto';
import { ReopenRightsClaimDto, ResolveRightsClaimDto } from './dto/resolve-rights-claim.dto';
import { UpdateRightsClaimDto } from './dto/update-rights-claim.dto';
import { RightsClaimsService } from './rights-claims.service';

@ApiTags('Rights Claims')
@ApiBearerAuth()
@Controller('admin/rights')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RightsClaimsController {
  constructor(private readonly service: RightsClaimsService) {}

  @Get('claims')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'List rights claims / DMCA notices' })
  @ApiResponse({ status: 200, type: RightsClaimListResponseDto })
  findAll(@Query() query: QueryRightsClaimsDto): Promise<RightsClaimListResponseDto> {
    return this.service.findAll(query);
  }

  @Get('claims/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Get a claim with components, blocks, attachments and audit trail' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: RightsClaimDetailDto })
  findOne(@Param('id', ParseUUIDPipe) id: string): Promise<RightsClaimDetailDto> {
    return this.service.findOne(id);
  }

  @Post('claims')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Register a rights claim' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  create(
    @Body() dto: CreateRightsClaimDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.create(dto, request.user.userId);
  }

  @Patch('claims/:id')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Update a rights claim (claims are never deleted)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 200, type: RightsClaimDetailDto })
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateRightsClaimDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.update(id, dto, request.user.userId);
  }

  @Post('claims/:id/status')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Change the workflow status of a claim' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  changeStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ChangeRightsClaimStatusDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.changeStatus(id, dto, request.user.userId);
  }

  @Post('claims/:id/assign')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Assign a claim to an editor' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  assign(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AssignRightsClaimDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.assign(id, dto, request.user.userId);
  }

  @Post('claims/:id/response')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Record the response sent to the claimant' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  recordResponse(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordClaimResponseDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.recordResponse(id, dto, request.user.userId);
  }

  @Post('claims/:id/counter-notice')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Record a counter notice' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  recordCounterNotice(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RecordCounterNoticeDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.recordCounterNotice(id, dto, request.user.userId);
  }

  @Post('claims/:id/resolve')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Resolve a claim' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  resolve(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ResolveRightsClaimDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.resolve(id, dto, request.user.userId);
  }

  @Post('claims/:id/reopen')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Reopen a resolved or closed claim (admin only)' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimDetailDto })
  reopen(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReopenRightsClaimDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimDetailDto> {
    return this.service.reopen(id, dto, request.user.userId);
  }

  @Post('claims/:id/blocks')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Apply a temporary access block for a claim' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: [RightsClaimAccessBlockDto] })
  applyBlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyClaimBlockDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimAccessBlockDto[]> {
    return this.service.applyBlock(id, dto, request.user.userId);
  }

  @Post('claims/:id/blocks/:blockId/lift')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Lift a temporary access block' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'blockId' })
  @ApiResponse({ status: 201, type: RightsClaimAccessBlockDto })
  liftBlock(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
    @Body() dto: LiftClaimBlockDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimAccessBlockDto> {
    return this.service.liftBlock(id, blockId, dto, request.user.userId);
  }

  @Post('claims/:id/components')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Link an affected component to a claim' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimComponentDto })
  linkComponent(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: LinkClaimComponentDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimComponentDto> {
    return this.service.linkComponent(id, dto, request.user.userId);
  }

  @Delete('claims/:id/components/:claimComponentId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Unlink an affected component' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'claimComponentId' })
  @ApiResponse({ status: 200, type: ClaimMutationResultDto })
  unlinkComponent(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('claimComponentId', ParseUUIDPipe) claimComponentId: string,
    @Req() request: { user: { userId: string } },
  ): Promise<ClaimMutationResultDto> {
    return this.service.unlinkComponent(id, claimComponentId, request.user.userId);
  }

  @Post('claims/:id/attachments')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Attach a document to a claim' })
  @ApiParam({ name: 'id' })
  @ApiResponse({ status: 201, type: RightsClaimAttachmentDto })
  addAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateClaimAttachmentDto,
    @Req() request: { user: { userId: string } },
  ): Promise<RightsClaimAttachmentDto> {
    return this.service.addAttachment(id, dto, request.user.userId);
  }

  @Delete('claims/:id/attachments/:attachmentId')
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({ summary: 'Soft-delete an attachment (the record is preserved)' })
  @ApiParam({ name: 'id' })
  @ApiParam({ name: 'attachmentId' })
  @ApiResponse({ status: 200, type: ClaimMutationResultDto })
  removeAttachment(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('attachmentId', ParseUUIDPipe) attachmentId: string,
    @Req() request: { user: { userId: string } },
  ): Promise<ClaimMutationResultDto> {
    return this.service.removeAttachment(id, attachmentId, request.user.userId);
  }
}
