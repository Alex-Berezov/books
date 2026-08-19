import { Module } from '@nestjs/common';
import { RightsClearanceResolverService } from './rights-clearance-resolver.service';

/**
 * Leaf module on purpose: the resolver is needed by the publication gate, geo-block generation and
 * license coverage, and those already sit on different levels of the module graph. Keeping it
 * dependency-free (Prisma aside) is what lets all three import it without a cycle.
 */
@Module({
  providers: [RightsClearanceResolverService],
  exports: [RightsClearanceResolverService],
})
export class RightsClearanceModule {}
