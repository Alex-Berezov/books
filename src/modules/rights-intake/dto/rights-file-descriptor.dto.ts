import { ApiProperty } from '@nestjs/swagger';

/**
 * WP-9.2 / WP-9.3 / WP-8.3: форма ответа на загрузку юридического файла (PDF-отчёт, файл
 * исходного издания, архивная копия доказательства) — зеркалит интерфейс
 * `RightsFileDescriptorDto` из `rights-files.service.ts`. Заведён отдельно в `dto/`, потому что
 * тот интерфейс — не класс и не годится для `@ApiOkResponse`/`@ApiCreatedResponse`
 * (Swagger читает рантайм-класс, а не тип).
 */
export class RightsFileDescriptorDto {
  @ApiProperty() storageKey!: string;
  @ApiProperty() sha256!: string;
  @ApiProperty({ type: String, nullable: true }) fileName!: string | null;
  @ApiProperty({ type: String, nullable: true }) contentType!: string | null;
  @ApiProperty({ type: Number, nullable: true }) sizeBytes!: number | null;
  @ApiProperty({ type: String, nullable: true }) uploadedAt!: string | null;
}
