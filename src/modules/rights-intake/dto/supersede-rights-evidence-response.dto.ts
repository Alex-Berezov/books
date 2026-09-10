import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ `PATCH /admin/rights/evidence/:evidenceId/supersede`. Сервис
 * (`RightsFilesService.supersedeEvidence`) отдаёт не запись целиком, а только то, что
 * изменилось: доказательство помечено неактуальным и указывает на преемника.
 * Удаления здесь нет по ADR-009.
 */
export class SupersedeRightsEvidenceResponseDto {
  @ApiProperty() id!: string;

  @ApiProperty({ description: 'Всегда `false`: доказательство перестало быть текущим' })
  isCurrent!: boolean;

  @ApiProperty({ description: 'Идентификатор заменяющего доказательства' })
  supersededById!: string;
}
