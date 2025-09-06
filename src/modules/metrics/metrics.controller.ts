import { Controller, Get, Res } from '@nestjs/common';
import { MetricsService } from './metrics.service';
import type { Response } from 'express';

@Controller()
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get('metrics')
  async getMetrics(@Res({ passthrough: true }) res: Response): Promise<string> {
    res.setHeader('Content-Type', this.metrics.contentType);
    return this.metrics.getMetrics();
  }
}
