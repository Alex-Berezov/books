import { LAWYER_ESCALATABLE_PROFILE_STATUSES } from './rights-lawyer.constants';

describe('LAWYER_ESCALATABLE_PROFILE_STATUSES', () => {
  it('does not list IMPORTED — RightsProfile.status never takes that value (LEGACY-035)', () => {
    expect(LAWYER_ESCALATABLE_PROFILE_STATUSES).not.toContain('IMPORTED');
  });

  it('still lists the one status a profile actually reaches on creation', () => {
    expect(LAWYER_ESCALATABLE_PROFILE_STATUSES).toContain('HUMAN_REVIEW_REQUIRED');
  });
});
