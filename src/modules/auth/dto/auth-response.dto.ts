import { ApiProperty } from '@nestjs/swagger';
import { Language as PrismaLanguage } from '@prisma/client';
import { ASSIGNABLE_ROLE_NAMES, type AssignableRoleName } from '../../users/users.constants';

/**
 * Ответы ручек авторизации.
 *
 * До 05.09.2026 оба класса жили прямо в `auth.controller.ts` и не имели ни
 * одного `@ApiProperty` (`LEGACY-133`): в `@ApiOkResponse({ type: AuthResponse })`
 * они уже стояли, но в OpenAPI уезжали **пустыми объектами**, то есть документ
 * обещал тип и не описывал ни одного поля.
 *
 * 🔴 Набор полей сверен с `AuthService.publicUser` (`auth.service.ts:403-417`)
 * и с тремя местами, которые добавляют к нему `roles` (`:167, :282, :361`).
 * Первая редакция этого файла описывала семь полей вместо двенадцати и
 * умалчивала о `roles` — найдено ревью в этом же заходе. Пустой объект хотя бы
 * ничего не обещал; неполный документ обещает и врёт, а фронт, собранный по
 * такой схеме, не увидел бы `user.roles` и разбирал бы админа как обычного
 * пользователя.
 *
 * ⚠️ `passwordHash` здесь нет и быть не должно.
 */
export class AuthUserResponse {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'user@example.com' })
  email!: string;

  @ApiProperty({ nullable: true, type: String, example: 'John Doe' })
  name?: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'John' })
  firstName?: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'Doe' })
  lastName?: string | null;

  @ApiProperty({ nullable: true, type: String, example: 'johnny' })
  nickname?: string | null;

  @ApiProperty({ example: true })
  isActive?: boolean;

  @ApiProperty({ nullable: true, type: String, format: 'uri' })
  avatarUrl?: string | null;

  @ApiProperty({ enum: PrismaLanguage, example: PrismaLanguage.en })
  languagePreference!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ nullable: true, type: String, format: 'date-time' })
  lastLogin?: Date | null;

  @ApiProperty({ enum: ASSIGNABLE_ROLE_NAMES, isArray: true, example: ['user'] })
  roles!: AssignableRoleName[];
}

/**
 * Пара токенов без пользователя — ответ `POST /auth/refresh`
 * (`auth.service.ts:364-378` возвращает ровно `{ accessToken, refreshToken }`).
 *
 * 🔴 Отдельный класс, а не `AuthResponse`: на `refresh` стоял
 * `@ApiOkResponse({ type: AuthResponse })`, и стоило `AuthResponse` перестать
 * быть пустым объектом, как документ начал обещать там обязательный `user`,
 * которого в ответе нет ни одного байта (найдено ревью в этом же заходе).
 */
export class AuthTokensResponse {
  @ApiProperty({ description: 'JWT access token' })
  accessToken!: string;

  @ApiProperty({ description: 'JWT refresh token' })
  refreshToken!: string;
}

/** Ответ `POST /auth/register`, `/auth/login` и `/auth/social`. */
export class AuthResponse extends AuthTokensResponse {
  @ApiProperty({ type: AuthUserResponse })
  user!: AuthUserResponse;
}
