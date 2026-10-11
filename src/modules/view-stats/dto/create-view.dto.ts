import { ApiProperty } from '@nestjs/swagger';
import { IsEnum, IsUUID } from 'class-validator';
import { ViewSource } from '@prisma/client';

export class CreateViewDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  bookVersionId!: string;

  @ApiProperty({ enum: ViewSource, enumName: 'ViewSource' })
  @IsEnum(ViewSource)
  source!: ViewSource;
}
