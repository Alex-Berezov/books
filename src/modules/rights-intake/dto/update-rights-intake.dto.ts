import { PartialType } from '@nestjs/swagger';
import { CreateRightsIntakeDto } from './create-rights-intake.dto';

export class UpdateRightsIntakeDto extends PartialType(CreateRightsIntakeDto) {}
