import { ApiProperty } from '@nestjs/swagger';

/**
 * Ответ на удаление контрибьютора (contributors.service.ts: remove -> personsService.remove).
 */
export class DeleteContributorResponseDto {
  @ApiProperty()
  id!: string;
}
