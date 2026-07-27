import { PartialType } from '@nestjs/swagger';
import { CreateBookVersionContributorDto } from './create-version-contributor.dto';

export class UpdateBookVersionContributorDto extends PartialType(CreateBookVersionContributorDto) {}
