import { ApiProperty } from '@nestjs/swagger';
import { RoleName } from '@prisma/client';

/**
 * Ответ `POST /users/:id/roles/:role` и `DELETE /users/:id/roles/:role`
 * (`UsersController.assignRole`/`.revokeRole`) — обе ручки в сервисе
 * возвращают одну и ту же форму `{ userId, role }`
 * (`users.service.ts:213`, `:233`).
 */
export class UserRoleDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ enum: RoleName })
  role!: RoleName;
}
