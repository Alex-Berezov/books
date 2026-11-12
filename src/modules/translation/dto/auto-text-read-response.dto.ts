import { ApiProperty } from '@nestjs/swagger';

/**
 * Отметка «прочитано» вкладки Summary или Analysis (`T184`). Response DTO - только Swagger,
 * без `class-validator` (`STYLE_GUIDE.md` §7).
 */
export class AutoTextReadDto {
  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When model text last landed in the fields of this tab (a run item written or accepted); null - never',
  })
  autoTextAt!: Date | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description: 'When the editor marked the text read; null - not marked',
  })
  readAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, description: 'Who marked the text read' })
  readById!: string | null;

  @ApiProperty({
    description:
      'true - nothing to read or the mark is not older than the last model text; false - publication of the version is refused (AUTO_TEXT_NOT_READ)',
  })
  read!: boolean;
}
