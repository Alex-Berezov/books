import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID } from 'class-validator';

/** WP-9.3 (R3-08): доказательство не удаляется (ADR-009), а заменяется другим. */
export class SupersedeRightsEvidenceDto {
  @ApiProperty({ description: 'Id доказательства, которое приходит на смену' })
  @IsString()
  @IsUUID()
  supersededById!: string;
}
