import { ApiProperty } from '@nestjs/swagger';

export class CommentUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ required: false, nullable: true })
  name?: string | null;
}
