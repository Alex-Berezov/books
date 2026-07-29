import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { AGENT_TOKEN_MIN_REVOKE_REASON_LENGTH } from '../rights-agent.constants';

export class RevokeAgentTokenDto {
  @ApiProperty({ description: 'Why the token is being revoked', minLength: 3 })
  @IsString()
  @MinLength(AGENT_TOKEN_MIN_REVOKE_REASON_LENGTH)
  @MaxLength(2000)
  reasonRu!: string;
}
