import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class GrantRightsPublicationOverrideDto {
  @ApiProperty({
    description:
      'Почему администратор снимает правовые ограничения с книги. Обязательно: решение ' +
      'последней инстанции пишется в журнал вместе с автором.',
    minLength: 10,
    maxLength: 2000,
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reasonRu!: string;
}

export class RevokeRightsPublicationOverrideDto {
  @ApiPropertyOptional({ description: 'Почему решение отменено.', maxLength: 2000 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(2000)
  reasonRu?: string;
}

export class RightsPublicationOverrideDto {
  @ApiProperty() id!: string;
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'null — книга удалена после решения; сама запись журнала остаётся',
  })
  bookId!: string | null;
  @ApiProperty({ description: 'Слаг книги на момент решения' })
  bookSlug!: string;
  @ApiProperty() reasonRu!: string;
  @ApiProperty({ format: 'date-time' }) grantedAt!: string;
  @ApiProperty({ type: String, nullable: true }) grantedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) grantedByEmail!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) revokedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) revokedByUserId!: string | null;
  @ApiProperty({ type: String, nullable: true }) revokedByEmail!: string | null;
  @ApiProperty({ type: String, nullable: true }) revokeReasonRu!: string | null;
}

export class RightsPublicationOverrideStateDto {
  @ApiProperty({ type: RightsPublicationOverrideDto, nullable: true })
  active!: RightsPublicationOverrideDto | null;

  @ApiProperty({
    type: [RightsPublicationOverrideDto],
    description: 'Все решения по книге, новые сверху; действующее тоже здесь.',
  })
  history!: RightsPublicationOverrideDto[];
}
