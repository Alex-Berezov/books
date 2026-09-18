import { RightsActionStatus, RightsClaimStatus } from '@prisma/client';

import {
  CLOSED_CLAIM_STATUSES as CLAIMS_MODULE_CLOSED_CLAIM_STATUSES,
  OPEN_CLAIM_STATUSES,
} from '../rights-claims/rights-claim.constants';
import { RESOLVED_ACTION_STATUSES } from '../rights-intake/rights-action.constants';
import {
  CLOSED_ACTION_STATUSES,
  CLOSED_CLAIM_STATUSES,
  LAWYER_ESCALATABLE_PROFILE_STATUSES,
} from './rights-lawyer.constants';

describe('LAWYER_ESCALATABLE_PROFILE_STATUSES', () => {
  it('does not list IMPORTED — RightsProfile.status never takes that value (LEGACY-035)', () => {
    expect(LAWYER_ESCALATABLE_PROFILE_STATUSES).not.toContain('IMPORTED');
  });

  it('still lists the one status a profile actually reaches on creation', () => {
    expect(LAWYER_ESCALATABLE_PROFILE_STATUSES).toContain('HUMAN_REVIEW_REQUIRED');
  });
});

// LEGACY-409: `rights-lawyer.constants.ts` cannot import these (ADR-003 — it must stay an
// import-free leaf), so the two copies of each closed-status list are cross-checked here
// instead of by the compiler. A spec file is not part of the runtime module graph, so these
// imports create no cycle.
describe('CLOSED_CLAIM_STATUSES / CLOSED_ACTION_STATUSES stay in sync (LEGACY-409)', () => {
  it('matches the terminal values of RightsClaimStatus and the rights-claims own list', () => {
    expect(new Set(CLOSED_CLAIM_STATUSES)).toEqual(new Set(CLAIMS_MODULE_CLOSED_CLAIM_STATUSES));
    for (const status of CLOSED_CLAIM_STATUSES) {
      expect(Object.values(RightsClaimStatus)).toContain(status);
    }
  });

  // `isOpenClaim` is a black list (`!CLOSED_CLAIM_STATUSES.includes(status)`), so a status added
  // to the enum and to neither list silently counts as open and inflates risk — which is exactly
  // how LEGACY-409 arose. Equality against the enum is what catches that, not the checks above.
  it('together with OPEN_CLAIM_STATUSES covers every value of RightsClaimStatus', () => {
    expect(new Set([...OPEN_CLAIM_STATUSES, ...CLOSED_CLAIM_STATUSES])).toEqual(
      new Set(Object.values(RightsClaimStatus)),
    );
  });

  it('matches RESOLVED_ACTION_STATUSES from rights-intake and RightsActionStatus', () => {
    expect(new Set(CLOSED_ACTION_STATUSES)).toEqual(new Set(RESOLVED_ACTION_STATUSES));
    for (const status of CLOSED_ACTION_STATUSES) {
      expect(Object.values(RightsActionStatus)).toContain(status);
    }
  });
});
