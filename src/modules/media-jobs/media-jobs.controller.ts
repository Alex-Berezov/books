import { Body, Controller, HttpCode, HttpStatus, Post, Query, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { MediaProbeService } from './media-probe.service';
import { MediaCleanupService } from './media-cleanup.service';

@ApiTags('media-jobs')
@Controller('admin/media')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
export class MediaJobsController {
  constructor(
    private readonly probe: MediaProbeService,
    private readonly cleanup: MediaCleanupService,
  ) {}

  @Post('reprobe')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enqueue ffprobe for all audio MediaAssets with missing duration' })
  @ApiResponse({ status: 202, description: 'Jobs enqueued' })
  async reprobe() {
    return this.probe.reprobeAll();
  }

  @Post('cleanup-orphans')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Run two-stage cleanup of orphan MediaAssets (soft-delete + hard-delete)',
  })
  @ApiQuery({ name: 'dryRun', required: false, type: Boolean })
  @ApiQuery({ name: 'softDays', required: false, type: Number })
  @ApiQuery({ name: 'hardDays', required: false, type: Number })
  async cleanupOrphans(
    @Query('dryRun') dryRun?: string,
    @Query('softDays') softDays?: string,
    @Query('hardDays') hardDays?: string,
  ) {
    return this.cleanup.cleanup({
      dryRun: /^(1|true)$/i.test(dryRun ?? ''),
      softDays: softDays ? Number(softDays) : undefined,
      hardDays: hardDays ? Number(hardDays) : undefined,
    });
  }

  @Post('probe')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Enqueue ffprobe for a single MediaAsset by id' })
  @ApiQuery({ name: 'id', required: true, type: String })
  async probeOne(@Query('id') id: string) {
    await this.probe.enqueueProbe(id);
    return { ok: true };
  }
}
