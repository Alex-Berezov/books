import { ApiProperty } from '@nestjs/swagger';

/** One entry of `GET /:lang/authors/letters` (`AuthorService.listPublicLetters`). */
export class AuthorLetterCountDto {
  @ApiProperty()
  letter!: string;

  @ApiProperty()
  count!: number;
}
