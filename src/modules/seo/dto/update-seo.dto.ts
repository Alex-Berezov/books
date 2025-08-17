import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsISO8601, IsOptional, IsString, IsUrl } from 'class-validator';

export class UpdateSeoDto {
  // === Основные мета-теги ===
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
  @IsUrl()
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
  @IsUrl()
  ogUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
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
  @IsUrl()
  eventUrl?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
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
