import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

/**
 * Формы Json-колонок версии книги: `characters`, `quotes`, `symbols`.
 *
 * 🔴 Живут в `shared`, а не в модуле версии: их читают ответы и `book-version`, и `book`
 * (обзор книги). До 10.09.2026 они лежали в `book-version/dto/book-version-response.dto.ts`,
 * а тот сам импортирует классы из `book/dto/book-detail-response.dto.ts` - кольцо
 * `book <-> book-version` на уровне файлов. При круговом импорте класс на момент исполнения
 * декоратора ещё `undefined`, и `@ApiProperty({ type: [X] })` собрал бы схему из пустого места.
 *
 * Форму на входе держат `@ValidateNested({ each: true })` + `@Type()` у
 * `CreateBookVersionDto`/`UpdateBookVersionDto.characters/quotes/symbols` (`LEGACY-402`,
 * закрыта) — сами эти классы несут декораторы полей, иначе `class-validator` внутрь
 * вложенного объекта не заглянет.
 */
export class BookVersionCharacterDto {
  @ApiProperty({ type: String })
  @IsString()
  name!: string;

  @ApiProperty({ type: String })
  @IsString()
  description!: string;
}

/** Цитата из книги (Json-колонка `quotes`). */
export class BookVersionQuoteDto {
  @ApiProperty({ type: String })
  @IsString()
  text!: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  author?: string;
}

/** Символ книги (Json-колонка `symbols`). */
export class BookVersionSymbolDto {
  @ApiProperty({ type: String })
  @IsString()
  title!: string;

  @ApiProperty({ type: String })
  @IsString()
  description!: string;
}
