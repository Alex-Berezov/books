import { PartialType } from '@nestjs/swagger';
import { CreateRightsLicenseDto } from './create-rights-license.dto';

export class UpdateRightsLicenseDto extends PartialType(CreateRightsLicenseDto) {}
