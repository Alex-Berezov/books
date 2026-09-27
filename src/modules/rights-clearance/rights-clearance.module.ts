import { Module } from '@nestjs/common';
import { RightsClearanceResolverService } from './rights-clearance-resolver.service';
import { RightsPublicationOverrideService } from './rights-publication-override.service';

/**
 * Leaf module on purpose: the resolver is needed by the publication gate, geo-block generation and
 * license coverage, and those already sit on different levels of the module graph. Keeping it
 * dependency-free (Prisma aside) is what lets all three import it without a cycle.
 *
 * The «Разрешить публикацию» journal service lives here for the same reason: the gate reads it,
 * and it needs nothing but Prisma. Its admin controller is `RightsPublicationOverrideModule`.
 */
@Module({
  providers: [RightsClearanceResolverService, RightsPublicationOverrideService],
  exports: [RightsClearanceResolverService, RightsPublicationOverrideService],
})
export class RightsClearanceModule {}
