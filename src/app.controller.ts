import { Controller, Get, Redirect } from '@nestjs/common';
import { ApiOkResponse } from '@nestjs/swagger';
import { AppService } from './app.service';
import { AppHealthResponseDto } from './modules/health/dto/app-health-response.dto';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  // Root: redirect to Swagger docs for convenience in prod
  @Get()
  @Redirect('/api/docs', 302)
  getRoot(): void {
    // no body needed; Redirect decorator handles the response
  }

  // Machine-readable health endpoint
  @Get('health')
  @ApiOkResponse({ type: AppHealthResponseDto })
  getHealth(): { status: string; uptime: number; timestamp: string } {
    return {
      status: 'ok',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    };
  }
}
