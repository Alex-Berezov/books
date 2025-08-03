import { IsString } from 'class-validator';

export class CreateBookDto {
  @IsString()
  slug: string;

  // Можно добавить другие поля при необходимости
}
