import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

export class AssignLawyerReviewDto {
  @ApiProperty({ description: 'Юрист из справочника RightsLawyer' })
  @IsUUID()
  lawyerId!: string;
}
