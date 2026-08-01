/** One territory decision narrowed to the fields that decide which market list it lands in. */
export interface TerritoryDecisionClassificationInput {
  countryCode: string;
  accessPolicy: string;
  finalStatus: string;
}

/** The four market lists a clearance produces for a book version. */
export interface ClearanceCountryLists {
  allowedCountryCodes: string[];
  blockedCountryCodes: string[];
  licenseRequiredCountryCodes: string[];
  pendingCountryCodes: string[];
}

export const emptyClearanceCountryLists = (): ClearanceCountryLists => ({
  allowedCountryCodes: [],
  blockedCountryCodes: [],
  licenseRequiredCountryCodes: [],
  pendingCountryCodes: [],
});

/**
 * Splits territory decisions into the four market lists a `BookVersion` carries.
 *
 * The branch order is carried over unchanged from the creation-time snapshot in
 * `RightsBookCreationService`: both the stored snapshot and the resolved-on-read lists must be
 * produced by the same rule, otherwise "what we published under" and "what applies now" would
 * differ for reasons that have nothing to do with the clearance changing.
 */
export const classifyTerritoryDecisions = (
  decisions: TerritoryDecisionClassificationInput[],
): ClearanceCountryLists => {
  const lists = emptyClearanceCountryLists();

  for (const decision of decisions) {
    const { countryCode, accessPolicy, finalStatus } = decision;

    // Phase 15: a country cleared by license is an allowed market, not a pending one.
    if (accessPolicy === 'ALLOW' || finalStatus === 'ALLOWED_BY_LICENSE') {
      lists.allowedCountryCodes.push(countryCode);
    } else if (accessPolicy === 'BLOCK' || finalStatus === 'BLOCKED') {
      lists.blockedCountryCodes.push(countryCode);
    } else if (finalStatus === 'LICENSE_REQUIRED') {
      lists.licenseRequiredCountryCodes.push(countryCode);
    } else if (
      accessPolicy === 'REVIEW_REQUIRED' ||
      finalStatus === 'PENDING_REVIEW' ||
      finalStatus === 'NOT_CHECKED'
    ) {
      lists.pendingCountryCodes.push(countryCode);
    }
  }

  return lists;
};

/** Narrow a Json column that should hold a list of country codes. */
export const toCountryCodeList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
