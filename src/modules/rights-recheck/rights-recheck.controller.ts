import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  PaginationInfoDto,
  paginatedSchema,
  type PaginatedResult,
} from '../../shared/dto/paginated-response.dto';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RightsRecheckSchedulerService } from './rights-recheck-scheduler.service';
import { RightsRecheckService } from './rights-recheck.service';
import { RightsReviewChainService } from './rights-review-chain.service';
import { RightsRecheckTriggerSource } from './rights-recheck-interface';
import { CompleteRecheckTaskDto } from './dto/complete-recheck-task.dto';
import { CreateRecheckTaskDto } from './dto/create-recheck-task.dto';
import { DismissRecheckTaskDto } from './dto/dismiss-recheck-task.dto';
import { ListRecheckTasksDto } from './dto/list-recheck-tasks.dto';
import { ListScanRunsDto } from './dto/list-scan-runs.dto';
import { SnoozeRecheckTaskDto } from './dto/snooze-recheck-task.dto';
import { UpdateRecheckScheduleDto } from './dto/update-recheck-schedule.dto';
import { RecheckScanRunDto } from './dto/recheck-scan-response.dto';
import {
  RecheckScheduleWithTasksDto,
  RecheckTaskDetailDto,
  RecheckTaskDto,
} from './dto/recheck-task-response.dto';
import { ReviewChainItemDto } from './dto/review-chain-response.dto';
import { VersionRecheckDto } from './dto/version-recheck-response.dto';

/**
 * Static segments are declared before parametric ones (`recheck/scan`, `recheck/scan-runs`
 * before `recheck/tasks/:taskId`) so Nest never matches `scan` as a task id.
 */
@ApiTags('rights-recheck')
@ApiExtraModels(RecheckScanRunDto, RecheckTaskDto, ReviewChainItemDto, PaginationInfoDto)
@Controller()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin, Role.ContentManager)
@ApiBearerAuth()
export class RightsRecheckController {
  constructor(
    private readonly recheck: RightsRecheckService,
    private readonly scheduler: RightsRecheckSchedulerService,
    private readonly reviewChain: RightsReviewChainService,
  ) {}

  @Post('admin/rights/recheck/scan')
  @ApiCreatedResponse({ type: RecheckScanRunDto })
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Run the recheck scan now (admin only)' })
  runScan(@Req() req: { user: { userId: string } }): Promise<RecheckScanRunDto> {
    return this.scheduler.runScan(RightsRecheckTriggerSource.MANUAL, req.user.userId);
  }

  @Get('admin/rights/recheck/scan-runs')
  @ApiOkResponse({ schema: paginatedSchema(RecheckScanRunDto) })
  @ApiOperation({ summary: 'History of recheck scan runs' })
  listScanRuns(@Query() query: ListScanRunsDto): Promise<PaginatedResult<RecheckScanRunDto>> {
    return this.scheduler.listScanRuns(query);
  }

  @Get('admin/rights/recheck/tasks')
  @ApiOkResponse({ schema: paginatedSchema(RecheckTaskDto) })
  @ApiOperation({ summary: 'List recheck tasks' })
  listTasks(@Query() query: ListRecheckTasksDto): Promise<PaginatedResult<RecheckTaskDto>> {
    return this.recheck.list(query);
  }

  @Post('admin/rights/recheck/tasks')
  @ApiOperation({ summary: 'Open a recheck task manually' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  createTask(
    @Body() dto: CreateRecheckTaskDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.createManual(dto, req.user.userId);
  }

  @Get('admin/rights/recheck/tasks/:taskId')
  @ApiOperation({ summary: 'Recheck task details and event timeline' })
  @ApiOkResponse({ type: RecheckTaskDetailDto })
  getTask(@Param('taskId') taskId: string): Promise<RecheckTaskDetailDto> {
    return this.recheck.getById(taskId);
  }

  @Post('admin/rights/recheck/tasks/:taskId/start')
  @ApiOperation({ summary: 'Take a recheck task into work' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  startTask(
    @Param('taskId') taskId: string,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.start(taskId, req.user.userId);
  }

  @Post('admin/rights/recheck/tasks/:taskId/complete')
  @ApiOperation({ summary: 'Close a recheck task' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  completeTask(
    @Param('taskId') taskId: string,
    @Body() dto: CompleteRecheckTaskDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.complete(taskId, dto, req.user.userId);
  }

  @Post('admin/rights/recheck/tasks/:taskId/dismiss')
  @ApiOperation({ summary: 'Dismiss a recheck task as not applicable' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  dismissTask(
    @Param('taskId') taskId: string,
    @Body() dto: DismissRecheckTaskDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.dismiss(taskId, dto, req.user.userId);
  }

  @Post('admin/rights/recheck/tasks/:taskId/snooze')
  @ApiOperation({ summary: 'Postpone reminders of a recheck task' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  snoozeTask(
    @Param('taskId') taskId: string,
    @Body() dto: SnoozeRecheckTaskDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.snooze(taskId, dto, req.user.userId);
  }

  @Post('admin/rights/recheck/tasks/:taskId/reopen')
  @Roles(Role.Admin)
  @ApiOperation({ summary: 'Reopen a closed recheck task (admin only)' })
  @ApiCreatedResponse({ type: RecheckTaskDetailDto })
  reopenTask(
    @Param('taskId') taskId: string,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckTaskDetailDto> {
    return this.recheck.reopen(taskId, req.user.userId);
  }

  @Get('admin/rights/intakes/:id/recheck-tasks')
  @ApiOkResponse({ schema: paginatedSchema(RecheckTaskDto) })
  @ApiOperation({ summary: 'Recheck tasks of an intake' })
  listIntakeTasks(
    @Param('id') id: string,
    @Query() query: ListRecheckTasksDto,
  ): Promise<PaginatedResult<RecheckTaskDto>> {
    return this.recheck.listByIntake(id, query);
  }

  @Get('admin/rights/intakes/:id/review-chain')
  @ApiOkResponse({ schema: paginatedSchema(ReviewChainItemDto) })
  @ApiOperation({ summary: 'Ordered history of rights reviews of an intake' })
  getReviewChain(@Param('id') id: string): Promise<PaginatedResult<ReviewChainItemDto>> {
    return this.reviewChain.getChainForIntake(id);
  }

  @Get('admin/rights/profiles/:id/recheck-schedule')
  @ApiOperation({ summary: 'Recheck schedule of a rights profile' })
  @ApiOkResponse({ type: RecheckScheduleWithTasksDto })
  getSchedule(@Param('id') id: string): Promise<RecheckScheduleWithTasksDto> {
    return this.recheck.getScheduleForProfile(id);
  }

  @Patch('admin/rights/profiles/:id/recheck-schedule')
  @ApiOperation({ summary: 'Update the recheck schedule / policy of a rights profile' })
  @ApiOkResponse({ type: RecheckScheduleWithTasksDto })
  updateSchedule(
    @Param('id') id: string,
    @Body() dto: UpdateRecheckScheduleDto,
    @Req() req: { user: { userId: string } },
  ): Promise<RecheckScheduleWithTasksDto> {
    return this.recheck.updateSchedule(id, dto, req.user.userId);
  }

  @Get('admin/versions/:id/recheck')
  @ApiOperation({ summary: 'Recheck state of a book version' })
  @ApiOkResponse({ type: VersionRecheckDto })
  getVersionRecheck(@Param('id') id: string): Promise<VersionRecheckDto> {
    return this.recheck.getVersionRecheck(id);
  }
}
