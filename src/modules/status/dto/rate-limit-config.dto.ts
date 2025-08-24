import { ApiProperty } from '@nestjs/swagger';

export class RateLimitConfigDto {
  @ApiProperty({ description: 'Is rate limiting enabled', example: false })
  enabled!: boolean;

  @ApiProperty({ description: 'Window size in milliseconds', example: 60000 })
  windowMs!: number;

  @ApiProperty({ description: 'Max actions allowed in window', example: 10 })
  maxPoints!: number;

  @ApiProperty({ description: 'Current driver name', example: 'inmemory' })
  driver!: string;

  @ApiProperty({ description: 'Keying strategy', example: 'userId|ip' })
  scope!: string;

  @ApiProperty({
    description: 'Endpoints protected by the rate limiter',
    isArray: true,
    example: ['POST /comments', 'PATCH /comments/:id', 'DELETE /comments/:id'],
  })
  endpoints!: string[];
}
