import { ApiProperty } from '@nestjs/swagger';
import { RightsLawyerType } from '../rights-lawyer-interface';

/** A lawyer as shown in the directory and in every selector. */
export class LawyerDto {
  @ApiProperty() id!: string;
  @ApiProperty() fullName!: string;
  @ApiProperty({ enum: RightsLawyerType }) lawyerType!: RightsLawyerType;
  @ApiProperty({ nullable: true }) organization!: string | null;
  @ApiProperty({ nullable: true }) barId!: string | null;
  @ApiProperty({ nullable: true }) email!: string | null;
  @ApiProperty({ nullable: true }) phone!: string | null;
  @ApiProperty({ type: [String] }) jurisdictionCodes!: string[];
  @ApiProperty({ nullable: true }) specializationRu!: string | null;
  @ApiProperty({ nullable: true }) notesRu!: string | null;
  @ApiProperty({ nullable: true }) userId!: string | null;
  @ApiProperty({ nullable: true }) userEmail!: string | null;
  /** Привязанный пользователь есть, но роли `lawyer` у него нет — UI показывает предупреждение. */
  @ApiProperty() hasLawyerRole!: boolean;
  @ApiProperty() isActive!: boolean;
  @ApiProperty({ nullable: true }) deactivatedAt!: string | null;
  @ApiProperty({ nullable: true }) deactivateReasonRu!: string | null;
  @ApiProperty() createdAt!: string;
  @ApiProperty() updatedAt!: string;
}

export class LawyerDetailDto extends LawyerDto {
  @ApiProperty() openReviewsCount!: number;
  @ApiProperty() decidedReviewsCount!: number;
  @ApiProperty() opinionsCount!: number;
}

export class LawyersListResponseDto {
  @ApiProperty({ type: [LawyerDto] }) items!: LawyerDto[];
  @ApiProperty() total!: number;
  @ApiProperty() page!: number;
  @ApiProperty() limit!: number;
}
