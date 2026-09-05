import { ApiPropertyOptional } from '@nestjs/swagger';
import { Language as PrismaLanguage } from '@prisma/client';
import { IsIn, IsOptional, IsString, IsUrl, Matches, MinLength } from 'class-validator';

/**
 * Тело `PATCH /users/me`. Вынесено из `users.controller.ts` 05.09.2026
 * (`LEGACY-133`); декораторы `class-validator` перенесены как есть, состав
 * полей и правила проверки не менялись.
 */
export class UpdateMeDto {
  @ApiPropertyOptional({ minLength: 2, example: 'John Doe' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @ApiPropertyOptional({
    minLength: 3,
    example: 'johnny',
    description: 'Letters, numbers and underscores only',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9_]+$/, {
    message: 'Nickname must contain only letters, numbers, and underscores',
  })
  @MinLength(3)
  nickname?: string;

  @ApiPropertyOptional({ format: 'uri' })
  @IsOptional()
  @IsUrl()
  avatarUrl?: string;

  @ApiPropertyOptional({ enum: PrismaLanguage })
  @IsOptional()
  @IsIn(Object.values(PrismaLanguage))
  languagePreference?: PrismaLanguage;
}
