import { PartialType } from '@nestjs/swagger';
import { CreateLegalChangeDto } from './create-legal-change.dto';

/** Every field is optional; only a DRAFT event may be edited. */
export class UpdateLegalChangeDto extends PartialType(CreateLegalChangeDto) {}
