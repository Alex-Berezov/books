import { ApiProperty } from '@nestjs/swagger';
import { RightsReviewColumnsDto } from '../../rights-intake/dto/rights-profile-response.dto';

/**
 * Проверка прав в истории дашборда версии (`reviewHistory`, `approvedReview`): колонки строки
 * `RightsReview` без связей. Пользователей решения и список решений дашборд не грузит — их
 * отдают `RightsReviewDto` профиля и ручка решений интейка; вложенный отчёт импорта
 * (`reportJson`, ключи хранилища) в историю не попадает (`LEGACY-183`, `T104j`).
 */
export class BookRightsDashboardReviewDto extends RightsReviewColumnsDto {
  // Phase 19: снимок юридического утверждения
  @ApiProperty({ type: Boolean }) lawyerReviewRequired!: boolean;
  @ApiProperty({ type: String, nullable: true }) lawyerReviewId!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerApprovedAt!: string | null;
  @ApiProperty({ type: String, nullable: true }) lawyerNameSnapshot!: string | null;
}
