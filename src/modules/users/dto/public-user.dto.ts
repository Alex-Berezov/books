import { ApiProperty } from '@nestjs/swagger';
import { Language as PrismaLanguage } from '@prisma/client';
import { ASSIGNABLE_ROLE_NAMES, type AssignableRoleName } from '../users.constants';

/**
 * Пользователь без ролей — форма `PublicUser` (`users.service.ts:39`), которую
 * отдают `GET /users/:id`, `PATCH /users/me`, `PATCH /users/profile`
 * и `DELETE /users/:id`.
 *
 * До 05.09.2026 класс жил прямо в `users.controller.ts` и не имел ни одного
 * `@ApiProperty` (`LEGACY-133`): валидация работала, а в OpenAPI объект уезжал
 * **пустым**, и генерация типов давала фронту тип без полей — вместо ошибки
 * компиляции получалось молчаливое поведение в духе `any`.
 *
 * 🔴 Роли вынесены в отдельный `PublicUserWithRolesDto` не для красоты: сервис
 * различает `PublicUser` и `PublicUser & { roles }` (`users.service.ts:48, 83,
 * 371`), и половина маршрутов роли не отдаёт. Один класс с обязательным `roles`
 * обещал бы их и там — фронт, переписывающий состояние пользователя ответом
 * `PATCH /users/me`, обнулил бы роли после сохранения имени (найдено ревью
 * в этом же заходе).
 */
export class PublicUserDto {
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

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLogin?: Date | null;
}

/**
 * Пользователь с ролями — форма `PublicUser & { roles }`, которую отдают
 * `GET /users/me`, `GET /users` (элементы списка), `POST /users`
 * и `PATCH /users/:id` (`users.service.ts:48, 283, 371, 418`).
 */
export class PublicUserWithRolesDto extends PublicUserDto {
  /**
   * Набор берётся из `ASSIGNABLE_ROLE_NAMES` — того же списка, которым
   * проверяется `CreateUserDto.roles`. Вторая копия литералов здесь завела бы
   * перечисление, расходящееся со списком молча (`LEGACY-204`).
   */
  @ApiProperty({ enum: ASSIGNABLE_ROLE_NAMES, isArray: true, example: ['user'] })
  roles!: AssignableRoleName[];
}
