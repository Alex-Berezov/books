import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** «Accept» иллюстрации героя (`F08-11a`): какую ожидающую картинку видел администратор. */
export class AcceptWorldImageDto {
  @ApiProperty({
    type: String,
    description:
      'mediaId of the pending image the admin saw; 409 WORLD_IMAGE_CHANGED when it was regenerated since',
  })
  @IsUUID()
  pendingMediaId!: string;
}
