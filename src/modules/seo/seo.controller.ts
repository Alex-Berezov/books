import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Put,
  UseGuards,
  Query,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiTags, ApiResponse, ApiBody, ApiQuery } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Role, Roles } from '../../common/decorators/roles.decorator';
import { SeoService } from './seo.service';
import { UpdateSeoDto } from './dto/update-seo.dto';
// no import of ResolveSeoType here to avoid type resolution warnings in validation decorators

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

  @Get('seo/resolve')
  @ApiOperation({ summary: 'Resolve SEO bundle (meta/OG/Twitter/canonical) with fallbacks' })
  @ApiQuery({ name: 'type', enum: ['book', 'version', 'page'] })
  @ApiQuery({
    name: 'id',
    description: 'Entity identifier or slug (book/page). For version: id only.',
  })
  @ApiResponse({ status: 200, description: 'Resolved SEO bundle' })
  resolve(@Query('type') typeRaw: string, @Query('id') idRaw: string): Promise<any> {
    const t = String(typeRaw);
    const id = String(idRaw);
    const allowed = ['book', 'version', 'page'] as const;
    const isAllowed = (val: string): val is (typeof allowed)[number] =>
      (allowed as readonly string[]).includes(val);
    if (!isAllowed(t)) throw new BadRequestException('Invalid type');
    return this.service.resolveByParams(t, id);
  }
}
