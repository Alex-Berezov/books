import { ApiProperty } from '@nestjs/swagger';

/** One entry of `GET /:lang/authors/letters` (`AuthorService.listPublicLetters`). */
export class AuthorLetterCountDto {
  @ApiProperty({ type: String })
  letter!: string;

  @ApiProperty({ type: Number })
  count!: number;
}
