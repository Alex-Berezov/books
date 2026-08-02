import { classifyTerritoryDecisions } from './rights-clearance.util';

describe('classifyTerritoryDecisions', () => {
  it('puts an allowed country into the allowed list', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'US', accessPolicy: 'ALLOW', finalStatus: 'ALLOWED' },
    ]);

    expect(lists.allowedCountryCodes).toEqual(['US']);
  });

  it('counts a country cleared by a license as allowed', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'US', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'ALLOWED_BY_LICENSE' },
    ]);

    expect(lists.allowedCountryCodes).toEqual(['US']);
    expect(lists.licenseRequiredCountryCodes).toEqual([]);
  });

  it('puts a blocked country into the blocked list', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'GB', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
    ]);

    expect(lists.blockedCountryCodes).toEqual(['GB']);
  });

  // WP-4.2 / R8-01: "a license is needed and access stays closed until it is bought" is the
  // valid pair Phase 15 was written for. Testing the block first swallowed it into the blocked
  // list, where the coverage check never looks — so a bought license opened nothing.
  it('treats a license-required country as license-required even when access is closed', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'DE', accessPolicy: 'BLOCK', finalStatus: 'LICENSE_REQUIRED' },
    ]);

    expect(lists.licenseRequiredCountryCodes).toEqual(['DE']);
    expect(lists.blockedCountryCodes).toEqual([]);
  });

  it('keeps a country blocked when the license requirement is not what closed it', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'DE', accessPolicy: 'BLOCK', finalStatus: 'BLOCKED' },
      { countryCode: 'FR', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'LICENSE_REQUIRED' },
    ]);

    expect(lists.blockedCountryCodes).toEqual(['DE']);
    expect(lists.licenseRequiredCountryCodes).toEqual(['FR']);
  });

  it('puts an unresolved country into the pending list', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'IT', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'PENDING_REVIEW' },
      { countryCode: 'PL', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'NOT_CHECKED' },
    ]);

    expect(lists.pendingCountryCodes).toEqual(['IT', 'PL']);
  });

  // WP-C.1: a market nobody plans to publish in is not an open question about publishing there.
  it('keeps a country outside the publication plan out of every market list', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'JP', accessPolicy: 'REVIEW_REQUIRED', finalStatus: 'NOT_TARGETED' },
    ]);

    expect(lists.pendingCountryCodes).toEqual([]);
    expect(lists.allowedCountryCodes).toEqual([]);
    expect(lists.blockedCountryCodes).toEqual([]);
    expect(lists.licenseRequiredCountryCodes).toEqual([]);
  });

  // WP-C.1, обратная сторона: `NOT_TARGETED` не отменяет явный запрет.
  it('keeps a not-targeted country blocked when the decision says BLOCK', () => {
    const lists = classifyTerritoryDecisions([
      { countryCode: 'JP', accessPolicy: 'BLOCK', finalStatus: 'NOT_TARGETED' },
    ]);

    expect(lists.blockedCountryCodes).toEqual(['JP']);
    expect(lists.pendingCountryCodes).toEqual([]);
  });
});
