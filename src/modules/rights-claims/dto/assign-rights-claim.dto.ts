import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class AssignRightsClaimDto {
  @ApiPropertyOptional({ nullable: true, description: 'null clears the assignment' })
  @IsOptional()
  @IsString()
  assignedToUserId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notesRu?: string;
}
