import {
  IsString,
  IsNotEmpty,
  IsArray,
  IsBoolean,
  IsOptional,
  ArrayMinSize,
  ValidateIf,
  ValidateNested,
  Matches,
  ValidateBy,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreateBookFromClearanceVersionDto } from './create-book-from-clearance-version.dto';
import {
  SLUG_MAX_LENGTH,
  SLUG_MAX_LENGTH_MESSAGE,
  SLUG_REGEX,
} from '../../../shared/validators/slug';

export class CreateBookFromClearanceDto {
  @ApiProperty({
    description: `Book slug. A new book's slug is at most ${SLUG_MAX_LENGTH} characters; when attaching, the existing book's slug is accepted as is`,
    example: 'the-picture-of-dorian-gray',
  })
  @IsString()
  @IsNotEmpty()
  @Matches(SLUG_REGEX, {
    message: 'slug must be lowercase alphanumeric with hyphens',
  })
  // `LEGACY-437`: новый слаг — не длиннее 100, как в `PATCH /books/:id`. Режим привязки несёт слаг
  // уже существующей книги, он может быть длиннее: его длину не проверяем.
  @ValidateBy({
    name: 'newBookSlugMaxLength',
    validator: {
      validate: (value: unknown, args) =>
        (args?.object as CreateBookFromClearanceDto | undefined)?.attachToExistingBook === true ||
        typeof value !== 'string' ||
        value.length <= SLUG_MAX_LENGTH,
      defaultMessage: () => SLUG_MAX_LENGTH_MESSAGE,
    },
  })
  slug!: string;

  /**
   * WP-L.2 (переходное): книга уже существует, и клиренс нужно привязать к ней, а не заводить
   * дубль. `POST /books` отключён в пользу этого канала, поэтому у книг, созданных до системы
   * прав, нет способа получить `currentRightsProfileId` — а без него гейт закрыт навсегда кодом
   * `MISSING_RIGHTS_PROFILE`.
   *
   * В этом режиме `slug` указывает на существующую книгу, а `versions` не передаются: снимок прав
   * получают уже заведённые версии на целевых языках клиренса. Убрать вместе с бэкфиллом старых книг.
   */
  @ApiPropertyOptional({
    description: 'Attach the clearance to the existing book with this slug instead of creating one',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  attachToExistingBook?: boolean;

  @ApiPropertyOptional({
    type: [CreateBookFromClearanceVersionDto],
    description: 'Book versions to create. Not allowed when attaching to an existing book.',
  })
  @ValidateIf((dto: CreateBookFromClearanceDto) => dto.attachToExistingBook !== true)
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => CreateBookFromClearanceVersionDto)
  versions!: CreateBookFromClearanceVersionDto[];
}
