import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum ResolveSeoType {
  book = 'book',
  version = 'version',
  page = 'page',
  category = 'category',
  tag = 'tag',
}

export class ResolveSeoQueryDto {
  @ApiProperty({ enum: ResolveSeoType })
  @IsEnum(ResolveSeoType)
  type!: ResolveSeoType;

  @ApiProperty({ description: 'ID (for version) or slug (for book/page)' })
  @IsString()
  @IsNotEmpty()
  id!: string;

  @ApiPropertyOptional({ description: 'Translation slug (for category/tag)' })
  @IsOptional()
  @IsString()
  slug?: string;
}
