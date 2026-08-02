import { ApiProperty } from '@nestjs/swagger';

/**
 * WP-F.5: пробел интейка — подсказка редактору перед отправкой агенту.
 *
 * Проверка **неблокирующая**: ни манифест, ни переход в `READY_FOR_AGENT` она не запрещает.
 * Блокирующий 400 сделал бы вход в систему строже, а задача этапа обратная.
 */
export class RightsIntakeReadinessItemDto {
  @ApiProperty({ example: 'TARGET_COUNTRIES_EMPTY' }) code!: string;
  @ApiProperty({ example: 'targetCountryCodes' }) field!: string;
  @ApiProperty() messageRu!: string;
}

export class RightsIntakeReadinessDto {
  @ApiProperty() intakeId!: string;
  /** `true` — минимальный пакет данных для агента собран. Ни на что не влияет, кроме подсказки. */
  @ApiProperty() isReady!: boolean;
  @ApiProperty({ type: [RightsIntakeReadinessItemDto] })
  missing!: RightsIntakeReadinessItemDto[];
  @ApiProperty({ type: [RightsIntakeReadinessItemDto] })
  warnings!: RightsIntakeReadinessItemDto[];
}
