import { ApiProperty } from '@nestjs/swagger';

export class CommentUserDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  email!: string;

  @ApiProperty({ required: false, nullable: true })
  name?: string | null;

  @ApiProperty({ required: false, nullable: true })
  nickname?: string | null;

  @ApiProperty({ required: false, nullable: true })
  avatarUrl?: string | null;
}
