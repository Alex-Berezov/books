import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsString } from 'class-validator';

export enum ResolveSeoType {
  book = 'book',
  version = 'version',
  page = 'page',
}

export class ResolveSeoQueryDto {
  @ApiProperty({ enum: ResolveSeoType })
  @IsEnum(ResolveSeoType)
  type!: ResolveSeoType;

  @ApiProperty({ description: 'ID (for version) or slug (for book/page)' })
  @IsString()
  @IsNotEmpty()
  id!: string;
}
