import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { HealthService, LivenessResult, ReadinessCheckResult } from './health.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly health: HealthService) {}

  @Get('liveness')
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiOkResponse({ description: 'Process is alive' })
  liveness(): LivenessResult {
    return this.health.liveness();
  }

  @Get('readiness')
  @ApiOperation({ summary: 'Readiness probe (DB + Redis)' })
  @ApiOkResponse({ description: 'Readiness status with details' })
  async readiness(): Promise<ReadinessCheckResult> {
    return this.health.readiness();
  }
}
