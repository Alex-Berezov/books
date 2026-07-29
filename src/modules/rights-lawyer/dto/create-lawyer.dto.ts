import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  IsArray,
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { RightsLawyerType } from '../rights-lawyer-interface';

export class CreateLawyerDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  fullName!: string;

  @ApiPropertyOptional({ enum: RightsLawyerType })
  @IsOptional()
  @IsEnum(RightsLawyerType)
  lawyerType?: RightsLawyerType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  organization?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  barId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  phone?: string;

  @ApiPropertyOptional({ type: [String], description: 'ISO 3166-1 alpha-2' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(250)
  @IsString({ each: true })
  jurisdictionCodes?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  specializationRu?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  notesRu?: string;

  /** `null` явно снимает привязку к пользователю, `undefined` — оставляет как есть. */
  @ApiPropertyOptional({ description: 'Пользователь платформы, от лица которого работает юрист' })
  @IsOptional()
  @ValidateIf((object: CreateLawyerDto) => object.userId !== null)
  @IsUUID()
  userId?: string | null;
}
