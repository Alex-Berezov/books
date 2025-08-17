import { Body, Controller, Get, Param, Put, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags, ApiResponse, ApiBody } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { SeoService } from './seo.service';
import { UpdateSeoDto } from './dto/update-seo.dto';

@ApiTags('seo')
@Controller()
export class SeoController {
  constructor(private readonly service: SeoService) {}

  @Get('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Get SEO meta for a book version' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiResponse({ status: 200, description: 'SEO meta or null if not set' })
  get(@Param('bookVersionId') bookVersionId: string) {
    return this.service.getByVersion(bookVersionId);
  }

  @Put('versions/:bookVersionId/seo')
  @ApiOperation({ summary: 'Create or update SEO meta for a book version (upsert)' })
  @ApiParam({ name: 'bookVersionId' })
  @ApiBody({
    description: 'Partial SEO fields to upsert',
    schema: {
      type: 'object',
      properties: {
        metaTitle: { type: 'string', example: 'My SEO title' },
        metaDescription: { type: 'string', example: 'Concise description' },
        canonicalUrl: { type: 'string', example: 'https://example.com/books/1' },
        ogImageUrl: { type: 'string', example: 'https://cdn.example.com/og.jpg' },
        eventStartDate: { type: 'string', example: '2025-08-17T12:00:00Z' },
      },
    },
  })
  @UseGuards(JwtAuthGuard, RolesGuard)
  @Roles(Role.Admin, Role.ContentManager)
  upsert(@Param('bookVersionId') bookVersionId: string, @Body() dto: UpdateSeoDto) {
    return this.service.upsertForVersion(bookVersionId, dto);
  }
}
