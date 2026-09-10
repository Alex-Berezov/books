import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Формы Json-колонок версии книги: `characters`, `quotes`, `symbols`.
 *
 * 🔴 Живут в `shared`, а не в модуле версии: их читают ответы и `book-version`, и `book`
 * (обзор книги). До 10.09.2026 они лежали в `book-version/dto/book-version-response.dto.ts`,
 * а тот сам импортирует классы из `book/dto/book-detail-response.dto.ts` - кольцо
 * `book <-> book-version` на уровне файлов. При круговом импорте класс на момент исполнения
 * декоратора ещё `undefined`, и `@ApiProperty({ type: [X] })` собрал бы схему из пустого места.
 *
 * ⚠️ Форму на входе не держит ничто: у `CreateBookVersionDto.characters/quotes/symbols` стоят
 * `@IsOptional() @IsArray()` с элементами `any`, без `@ValidateNested()` и `@Type()`
 * (`book-version/dto/create-book-version.dto.ts`). Обязательность полей здесь описывает
 * намерение, а не проверенный инвариант.
 */
export class BookVersionCharacterDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({ type: String })
  description!: string;
}

/** Цитата из книги (Json-колонка `quotes`). */
export class BookVersionQuoteDto {
  @ApiProperty({ type: String })
  text!: string;

  @ApiPropertyOptional({ type: String })
  author?: string;
}

/** Символ книги (Json-колонка `symbols`). */
export class BookVersionSymbolDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: String })
  description!: string;
}
