import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsUUID } from 'class-validator';

export class AssignRightsClaimDto {
  @ApiPropertyOptional({ nullable: true, description: 'null clears the assignment' })
  @IsOptional()
  @IsUUID()
  assignedToUserId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}
