import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { BackgroundJobsRegistry } from './background-jobs.registry';

@ApiTags('admin')
@Controller()
export class BackgroundJobsController {
  constructor(private readonly registry: BackgroundJobsRegistry) {}

  /**
   * То же, что печатается в лог при старте, но снаружи и машиночитаемо: чтобы
   * состояние можно было проверить, не заходя в контейнер, и повесить алерт.
   */
  @Get('admin/background-jobs')
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  @ApiOperation({
    summary: 'Which background mechanisms are actually running',
    description:
      'Three states per mechanism: ACTIVE, DEGRADED (runs, but not the way it was designed to) and DISABLED, with a mandatory reason for the last two. Exists because three mechanisms in one week turned out never to have run, and none of them gave a sign: no error, no metric, no log line — the absence of work was indistinguishable from normal work. DISABLED here is not automatically a fault: a mechanism switched off by an environment flag is a decision, and only the reason tells the two apart.',
  })
  @ApiResponse({ status: 200, description: 'Every registered mechanism with its state and reason' })
  list() {
    return this.registry.summary();
  }
}
