import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { QueueService } from './queue.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles, Role } from '../../common/decorators/roles.decorator';
import { QueueStatusResponseDto } from './dto/queue-status-response.dto';
import { EnqueueDemoResponseDto } from './dto/enqueue-demo-response.dto';

@ApiTags('queues')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(Role.Admin)
@Controller('queues')
export class QueueController {
  constructor(private readonly queues: QueueService) {}

  @Get('status')
  @ApiOperation({ summary: 'Queues subsystem status' })
  @ApiOkResponse({ type: QueueStatusResponseDto })
  status() {
    return this.queues.status();
  }

  @Get('demo/stats')
  @ApiOperation({ summary: 'Demo queue stats' })
  async stats() {
    return this.queues.getDemoStats();
  }

  @Post('demo/enqueue')
  @ApiOperation({ summary: 'Enqueue a demo job' })
  @ApiCreatedResponse({ type: EnqueueDemoResponseDto })
  async enqueue(@Body() data: Record<string, unknown> = {}) {
    return this.queues.enqueueDemo(data);
  }
}
