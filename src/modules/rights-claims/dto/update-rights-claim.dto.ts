import { PartialType } from '@nestjs/swagger';
import { CreateRightsClaimDto } from './create-rights-claim.dto';

export class UpdateRightsClaimDto extends PartialType(CreateRightsClaimDto) {}
