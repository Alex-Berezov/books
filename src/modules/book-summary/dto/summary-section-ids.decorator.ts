import { applyDecorators } from '@nestjs/common';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import { SUMMARY_SECTION_LIMITS } from './create-book-summary-section.dto';

/** Порядок разделов, который видела вкладка (`from`/`to`, T5): `id` разделов версии, не больше их предела. */
export const SummarySectionIds = () =>
  applyDecorators(
    IsArray(),
    ArrayMinSize(1),
    ArrayMaxSize(SUMMARY_SECTION_LIMITS.sectionsPerVersion),
    IsUUID('all', { each: true }),
  );
