import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export enum ResolveSeoType {
  book = 'book',
  version = 'version',
  page = 'page',
  category = 'category',
  genre = 'genre',
  tag = 'tag',
  catalog = 'catalog',
  collection = 'collection',
}

/**
 * Те же восемь значений, но как union строковых литералов.
 *
 * `LEGACY-319`. Enum в TypeScript номинален: `'book'` в `ResolveSeoType`
 * не присваивается, и метод, объявленный через сам enum, потребовал бы
 * `ResolveSeoType.book` в каждом вызове и в каждой спеке. Поэтому валидатор
 * и Swagger берут enum (им нужно значение времени выполнения), а сигнатуры
 * и сужения типов берут этот union. Список у них общий: он выведен из enum
 * шаблонным типом, разойтись им негде.
 */
export type ResolveSeoTypeValue = `${ResolveSeoType}`;

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
