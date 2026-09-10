import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, Max, Min } from 'class-validator';

export enum UploadType {
  cover = 'cover',
  audio = 'audio',
}

export class PresignRequestDto {
  @ApiProperty({ enum: UploadType, example: UploadType.cover })
  @IsEnum(UploadType)
  type!: UploadType;

  @ApiProperty({ description: 'MIME type of the file', example: 'image/jpeg' })
  @IsString()
  @IsNotEmpty()
  contentType!: string;

  @ApiProperty({ description: 'Estimated file size in bytes', example: 1024 * 1024 })
  @IsInt()
  @Min(1)
  @Max(1_000_000_000)
  size!: number;
}

export class PresignResponseDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({
    type: String,
    description: 'Direct upload URL (for local driver this is API endpoint)',
  })
  url!: string;

  @ApiProperty({ description: 'HTTP method to use', enum: ['POST', 'PUT'], example: 'POST' })
  method!: 'POST' | 'PUT';

  /**
   * `additionalProperties` здесь не украшение: без него `@ApiProperty` над
   * `Record<string, string>` уезжает в OpenAPI как `type: object` без единого свойства,
   * и машинная сверка на фронте видит «объект без читаемых полей» вместо словаря строк
   * (`LEGACY-374`). Ключи заранее не известны — их задаёт драйвер хранилища, — поэтому
   * описывается не список полей, а тип значения.
   */
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: { type: 'string' },
    description: 'Headers to include with upload request',
  })
  @IsOptional()
  headers?: Record<string, string>;

  @ApiProperty({ type: String, description: 'Token required by direct upload endpoint' })
  token!: string;

  @ApiProperty({ type: Number, description: 'Time-to-live in seconds' })
  ttlSec!: number;
}

export class DirectUploadResponseDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String })
  publicUrl!: string;
}
