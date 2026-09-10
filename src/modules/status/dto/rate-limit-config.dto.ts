import { ApiProperty } from '@nestjs/swagger';

export class RateLimitConfigDto {
  @ApiProperty({ type: Boolean, description: 'Is rate limiting enabled', example: false })
  enabled!: boolean;

  @ApiProperty({ type: Number, description: 'Window size in milliseconds', example: 60000 })
  windowMs!: number;

  @ApiProperty({ type: Number, description: 'Max actions allowed in window', example: 10 })
  maxPoints!: number;

  @ApiProperty({ type: String, description: 'Current driver name', example: 'inmemory' })
  driver!: string;

  @ApiProperty({ type: String, description: 'Keying strategy', example: 'userId|ip' })
  scope!: string;

  @ApiProperty({
    description: 'Endpoints protected by the rate limiter',
    type: String,
    isArray: true,
    example: ['POST /comments', 'PATCH /comments/:id', 'DELETE /comments/:id'],
  })
  endpoints!: string[];
}
