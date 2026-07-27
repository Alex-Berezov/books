import { PartialType } from '@nestjs/swagger';
import { CreateContributorDto } from './create-contributor.dto';

export class UpdateContributorDto extends PartialType(CreateContributorDto) {}
