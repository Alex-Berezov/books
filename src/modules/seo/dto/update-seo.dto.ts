import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString } from 'class-validator';
import { IsAbsoluteHttpUrl } from '../../../shared/validators/absolute-http-url.decorator';

export class UpdateSeoDto {
  // === Primary meta tags ===
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  metaDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsAbsoluteHttpUrl()
  canonicalUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  robots?: string;

  // === Open Graph ===
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogTitle?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsAbsoluteHttpUrl()
  ogUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsAbsoluteHttpUrl()
  ogImageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ogImageAlt?: string;

  // === Twitter Card ===
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  twitterCard?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  twitterSite?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  twitterCreator?: string;

  // === Event schema ===
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventDescription?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  eventStartDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  eventEndDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsAbsoluteHttpUrl()
  eventUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsAbsoluteHttpUrl()
  eventImageUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationStreet?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationCity?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationRegion?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationPostal?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  eventLocationCountry?: string;
}
