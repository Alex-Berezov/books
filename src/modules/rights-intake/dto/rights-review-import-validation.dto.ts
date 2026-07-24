import { ApiProperty } from '@nestjs/swagger';

export class ValidationIssueDto {
  @ApiProperty() path!: string;
  @ApiProperty() message!: string;
  @ApiProperty() code!: string;
}
