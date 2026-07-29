import { PartialType } from '@nestjs/swagger';
import { CreateLawyerDto } from './create-lawyer.dto';

/** Every field of `CreateLawyerDto` is optional; validation rules are inherited. */
export class UpdateLawyerDto extends PartialType(CreateLawyerDto) {}
