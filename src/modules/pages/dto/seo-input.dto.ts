import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class SeoInputDto {
  @ApiPropertyOptional({ description: 'Meta title' })
  @IsOptional()
  @IsString()
  metaTitle?: string | null;

  @ApiPropertyOptional({ description: 'Meta description' })
  @IsOptional()
  @IsString()
  metaDescription?: string | null;

  @ApiPropertyOptional({ description: 'Canonical URL' })
  @IsOptional()
  @IsString()
  canonicalUrl?: string | null;

  @ApiPropertyOptional({ description: 'Robots meta tag' })
  @IsOptional()
  @IsString()
  robots?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph title' })
  @IsOptional()
  @IsString()
  ogTitle?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph description' })
  @IsOptional()
  @IsString()
  ogDescription?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph type' })
  @IsOptional()
  @IsString()
  ogType?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph URL' })
  @IsOptional()
  @IsString()
  ogUrl?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image URL' })
  @IsOptional()
  @IsString()
  ogImageUrl?: string | null;

  @ApiPropertyOptional({ description: 'Open Graph image alt text' })
  @IsOptional()
  @IsString()
  ogImageAlt?: string | null;

  @ApiPropertyOptional({ description: 'Twitter card type' })
  @IsOptional()
  @IsString()
  twitterCard?: string | null;

  @ApiPropertyOptional({ description: 'Twitter site handle' })
  @IsOptional()
  @IsString()
  twitterSite?: string | null;

  @ApiPropertyOptional({ description: 'Twitter creator handle' })
  @IsOptional()
  @IsString()
  twitterCreator?: string | null;
}
