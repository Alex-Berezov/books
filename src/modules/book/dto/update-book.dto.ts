import { IsOptional, IsString } from 'class-validator';

export class UpdateBookDto {
  @IsOptional()
  @IsString()
  slug?: string;

  // Можно добавить другие поля при необходимости
}
