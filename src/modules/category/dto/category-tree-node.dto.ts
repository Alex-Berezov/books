import { ApiProperty } from '@nestjs/swagger';
import { CategoryType } from '@prisma/client';

export class CategoryTreeNodeDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  slug!: string;

  @ApiProperty({ enum: CategoryType })
  type!: CategoryType;

  @ApiProperty({ type: 'string', nullable: true, required: false })
  parentId?: string | null;

  @ApiProperty({ type: () => [CategoryTreeNodeDto] })
  children!: CategoryTreeNodeDto[];
}
