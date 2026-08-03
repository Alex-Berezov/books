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
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { CreateBookFromClearanceVersionDto } from './create-book-from-clearance-version.dto';

export class CreateBookFromClearanceDto {
  @ApiProperty({ description: 'Book slug', example: 'the-picture-of-dorian-gray' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, {
    message: 'slug must be lowercase alphanumeric with hyphens',
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
