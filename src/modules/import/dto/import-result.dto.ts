import { ApiProperty } from '@nestjs/swagger';

class ImportErrorDto {
  @ApiProperty() key!: string;
  @ApiProperty() message!: string;
}

/**
 * Response of `POST /import/categories` and `POST /import/tags` — mirrors `ImportResult`
 * from `import.service.ts`. Same shape for both routes, one DTO covers both.
 */
export class ImportResultDto {
  @ApiProperty() imported!: number;
  @ApiProperty() updated!: number;
  @ApiProperty({ type: [ImportErrorDto] }) errors!: ImportErrorDto[];
}
