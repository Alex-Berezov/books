import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsString } from 'class-validator';
import { SLUG_REDIRECT_ENTITY_TYPES, SlugRedirectEntityType } from '../slug-redirect.service';

export class SlugRedirectQueryDto {
  @ApiProperty({ enum: SLUG_REDIRECT_ENTITY_TYPES, description: 'Entity whose slug changed' })
  @IsIn(SLUG_REDIRECT_ENTITY_TYPES)
  entityType!: SlugRedirectEntityType;

  @ApiProperty({ description: 'The slug that no longer resolves' })
  @IsString()
  @IsNotEmpty()
  slug!: string;
}
