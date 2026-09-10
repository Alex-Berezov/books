import { ApiPropertyOptional } from '@nestjs/swagger';

/** Response of `GET /:lang/slug-redirect` (`PublicController.slugRedirect`). */
export class SlugRedirectResponseDto {
  @ApiPropertyOptional({
    type: String,
    description: 'Current slug the retired one redirects to, null when there is none',
    nullable: true,
  })
  newSlug!: string | null;
}
