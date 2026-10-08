import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsString,
  MinLength,
  IsOptional,
  IsBoolean,
  IsArray,
  IsIn,
} from 'class-validator';
import { ASSIGNABLE_ROLE_NAMES, type AssignableRoleName } from '../users.constants';
import { NormalizeEmail } from '../../../shared/validators/normalize-email.decorator';

export class CreateUserDto {
  @ApiProperty({ example: 'user@example.com' })
  @IsEmail()
  @NormalizeEmail()
  email!: string;

  @ApiProperty({ example: 'securePassword123', minLength: 6 })
  @IsString()
  @MinLength(6)
  password!: string;

  @ApiPropertyOptional({ example: 'John' })
  @IsOptional()
  @IsString()
  firstName?: string;

  @ApiPropertyOptional({ example: 'Doe' })
  @IsOptional()
  @IsString()
  lastName?: string;

  @ApiPropertyOptional({ example: ['user'], enum: ASSIGNABLE_ROLE_NAMES, isArray: true })
  @IsOptional()
  @IsArray()
  @IsIn(ASSIGNABLE_ROLE_NAMES, { each: true })
  roles?: AssignableRoleName[];

  @ApiPropertyOptional({ example: true, default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
