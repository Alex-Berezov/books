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
    } else if (finalStatus === 'LICENSE_REQUIRED') {
      // WP-4.2 / R8-01: "a license is needed, and until it is bought the access is closed" is the
      // pair Phase 15 exists for, and it arrives as `LICENSE_REQUIRED` + `BLOCK`. While the block
      // was tested first, such a country went into the blocked list, where the coverage check
      // never looks — the license could not open it, ever. The runtime projection is unaffected:
      // geo-block rules are generated from the decision itself, not from these lists.
      lists.licenseRequiredCountryCodes.push(countryCode);
    } else if (accessPolicy === 'BLOCK' || finalStatus === 'BLOCKED') {
      lists.blockedCountryCodes.push(countryCode);
    } else if (finalStatus === 'NOT_TARGETED' && accessPolicy !== 'BLOCK') {
      // WP-C.1: сужение области `pendingCountryCodes`, а не отмена правила. «Рынок не
      // обслуживается» — это решение, а не открытый вопрос: страна вне плана публикации
      // попадала в pending и через `PENDING_TERRITORIES` запрещала релиз на целевых рынках.
      // Явный запрет сильнее: ветка выше уже забрала `accessPolicy = BLOCK` в blocked, а
      // условие здесь фиксирует это намерение на случай перестановки веток.
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
