import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import {
  RightsLicenseDelegate,
  RightsLicenseLinkDelegate,
  RightsLicenseMediaFormat,
  RightsLicenseRecord,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  toStringArray,
} from './rights-license-interface';

export type LicenseCoverageStatus = 'NOT_REQUIRED' | 'COVERED' | 'PARTIAL' | 'NOT_COVERED';

export interface LicenseIssue {
  code: string;
  severity: 'BLOCKER' | 'WARNING';
  messageRu: string;
  licenseId?: string;
  countryCode?: string;
}

export interface CountryCoverageResult {
  countryCode: string;
  covered: boolean;
  licenseIds: string[];
  issues: LicenseIssue[];
}

export interface LicenseCoverageResult {
  status: LicenseCoverageStatus;
  checkedAt: string;
  requiredCountryCodes: string[];
  coveredCountryCodes: string[];
  uncoveredCountryCodes: string[];
  countries: CountryCoverageResult[];
  licenseIds: string[];
  blockers: LicenseIssue[];
  warnings: LicenseIssue[];
  attributionTextsRu: string[];
}

export interface EvaluateCoverageInput {
  requiredCountryCodes: string[];
  languageCode: string | null;
  requiredMediaFormats: RightsLicenseMediaFormat[];
  licenses: RightsLicenseRecord[];
  at: Date;
  /** Enables the LICENSE_TRANSLATION_NOT_ALLOWED advisory warning. */
  hasTranslationComponent?: boolean;
}

/** Territory statuses whose countries need a license before the version may be published. */
const LICENSE_RELEVANT_TERRITORY_STATUSES = ['LICENSE_REQUIRED', 'ALLOWED_BY_LICENSE'];

const EXPIRING_SOON_DAYS = 90;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Ordered most-specific first: when several licenses fail for a country, the first match wins. */
const ISSUE_CODE_PRIORITY = [
  'LICENSE_REVOKED',
  'LICENSE_EXPIRED',
  'LICENSE_NOT_YET_EFFECTIVE',
  'LICENSE_STATUS_NOT_ACTIVE',
  'LICENSE_SCOPE_MEDIA_MISMATCH',
  'LICENSE_SCOPE_LANGUAGE_MISMATCH',
  'LICENSE_MISSING_FOR_COUNTRY',
];

interface TerritoryDecisionRow {
  countryCode: string;
}

/**
 * `ALLOWED_BY_LICENSE` is not yet present in the checked-in Prisma client enum
 * (no local `prisma generate`), so territory decisions are read via a dynamic delegate.
 */
interface TerritoryDecisionDelegate {
  findMany(args: Record<string, unknown>): Promise<TerritoryDecisionRow[]>;
}

interface RightsComponentRow {
  componentType: string;
}

interface VersionCoverageContext {
  id: string;
  language: string;
  type: string;
  rightsProfileId: string | null;
}

@Injectable()
export class RightsLicenseCoverageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clearanceResolver: RightsClearanceResolverService,
  ) {}

  private get licenseDelegate(): RightsLicenseDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicense'
    ] as RightsLicenseDelegate;
  }

  private get linkDelegate(): RightsLicenseLinkDelegate {
    return (this.prisma as unknown as Record<string, unknown>)[
      'rightsLicenseLink'
    ] as RightsLicenseLinkDelegate;
  }

  // ---------------------------------------------------------------------------
  // Pure scope helpers
  // ---------------------------------------------------------------------------

  effectiveStatus(license: RightsLicenseRecord, at: Date): RightsLicenseStatus {
    if (license.revokedAt) return RightsLicenseStatus.REVOKED;

    const passthrough = [
      RightsLicenseStatus.REVOKED,
      RightsLicenseStatus.SUPERSEDED,
      RightsLicenseStatus.DRAFT,
      RightsLicenseStatus.PENDING,
      RightsLicenseStatus.UNCERTAIN,
    ];
    if (passthrough.includes(license.status)) return license.status;

    if (!license.isPerpetual && license.expiresAt && license.expiresAt.getTime() <= at.getTime()) {
      return RightsLicenseStatus.EXPIRED;
    }
    if (license.effectiveFrom && license.effectiveFrom.getTime() > at.getTime()) {
      return RightsLicenseStatus.PENDING;
    }
    return license.status;
  }

  isActiveAt(license: RightsLicenseRecord, at: Date): boolean {
    return this.effectiveStatus(license, at) === RightsLicenseStatus.ACTIVE;
  }

  coversCountry(license: RightsLicenseRecord, countryCode: string): boolean {
    const code = countryCode.toUpperCase();
    switch (license.territoryScope) {
      case RightsLicenseTerritoryScope.WORLDWIDE:
        return true;
      case RightsLicenseTerritoryScope.COUNTRY_LIST:
        return toStringArray(license.countryCodes)
          .map((item) => item.toUpperCase())
          .includes(code);
      case RightsLicenseTerritoryScope.EXCEPT_COUNTRY_LIST:
        return !toStringArray(license.excludedCountryCodes)
          .map((item) => item.toUpperCase())
          .includes(code);
      default:
        return false;
    }
  }

  coversLanguage(license: RightsLicenseRecord, languageCode: string | null): boolean {
    const languages = toStringArray(license.languageCodes);
    if (languages.length === 0) return true;
    if (!languageCode) return true;
    return languages.map((item) => item.toLowerCase()).includes(languageCode.toLowerCase());
  }

  coversMediaFormats(license: RightsLicenseRecord, required: RightsLicenseMediaFormat[]): boolean {
    const formats = toStringArray(license.mediaFormats);
    if (formats.length === 0) return true;
    if (required.length === 0) return true;
    return required.some((format) => formats.includes(format));
  }

  mediaFormatsForVersionType(type: string): RightsLicenseMediaFormat[] {
    if (type === 'text') {
      return [RightsLicenseMediaFormat.TEXT_ONLINE, RightsLicenseMediaFormat.TEXT_DOWNLOAD];
    }
    if (type === 'audio') {
      return [RightsLicenseMediaFormat.AUDIO_STREAMING, RightsLicenseMediaFormat.AUDIO_DOWNLOAD];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // Coverage evaluation
  // ---------------------------------------------------------------------------

  evaluateCoverage(input: EvaluateCoverageInput): LicenseCoverageResult {
    const { languageCode, requiredMediaFormats, licenses, at } = input;
    const checkedAt = at.toISOString();

    const requiredCountryCodes = Array.from(
      new Set(input.requiredCountryCodes.map((code) => code.toUpperCase())),
    ).sort();

    const warnings: LicenseIssue[] = [];
    const usedLicenseIds = new Set<string>();
    const attributionTextsRu: string[] = [];

    if (requiredCountryCodes.length === 0) {
      return {
        status: 'NOT_REQUIRED',
        checkedAt,
        requiredCountryCodes: [],
        coveredCountryCodes: [],
        uncoveredCountryCodes: [],
        countries: [],
        licenseIds: [],
        blockers: [],
        warnings: [],
        attributionTextsRu: [],
      };
    }

    for (const license of licenses) {
      if (license.territoryScope === RightsLicenseTerritoryScope.UNKNOWN) {
        warnings.push({
          code: 'LICENSE_TERRITORY_SCOPE_UNKNOWN',
          severity: 'WARNING',
          messageRu: `У лицензии «${license.title}» не определена территория действия — покрытие рынков подтвердить нельзя.`,
          licenseId: license.id,
        });
      }
    }

    const countries: CountryCoverageResult[] = requiredCountryCodes.map((countryCode) =>
      this.evaluateCountry(countryCode, {
        languageCode,
        requiredMediaFormats,
        licenses,
        at,
      }),
    );

    for (const country of countries) {
      for (const licenseId of country.licenseIds) usedLicenseIds.add(licenseId);
    }

    for (const license of licenses) {
      if (!usedLicenseIds.has(license.id)) continue;

      if (license.attributionRequired) {
        warnings.push({
          code: 'LICENSE_ATTRIBUTION_REQUIRED',
          severity: 'WARNING',
          messageRu: `Лицензия «${license.title}» требует указания правообладателя при публикации.`,
          licenseId: license.id,
        });
        if (license.requiredAttributionText) {
          attributionTextsRu.push(license.requiredAttributionText);
        }
      }

      if (this.isExpiringSoon(license, at)) {
        warnings.push({
          code: 'LICENSE_EXPIRING_SOON',
          severity: 'WARNING',
          messageRu: `Лицензия «${license.title}» истекает в ближайшие ${EXPIRING_SOON_DAYS} дней.`,
          licenseId: license.id,
        });
      }

      if (input.hasTranslationComponent && !license.translationAllowed) {
        warnings.push({
          code: 'LICENSE_TRANSLATION_NOT_ALLOWED',
          severity: 'WARNING',
          messageRu: `Лицензия «${license.title}» не разрешает перевод, а в профиле есть компонент перевода.`,
          licenseId: license.id,
        });
      }

      // Informational: a language-scoped license that forbids sublicensing constrains
      // what may be done with the language edition it covers.
      if (!license.sublicensingAllowed && toStringArray(license.languageCodes).length > 0) {
        warnings.push({
          code: 'LICENSE_SUBLICENSING_NOT_ALLOWED',
          severity: 'WARNING',
          messageRu: `Лицензия «${license.title}» не разрешает сублицензирование языкового издания.`,
          licenseId: license.id,
        });
      }
    }

    const coveredCountryCodes = countries.filter((c) => c.covered).map((c) => c.countryCode);
    const uncoveredCountryCodes = countries.filter((c) => !c.covered).map((c) => c.countryCode);
    const blockers = countries.flatMap((c) => c.issues.filter((i) => i.severity === 'BLOCKER'));

    let status: LicenseCoverageStatus;
    if (uncoveredCountryCodes.length === 0) status = 'COVERED';
    else if (coveredCountryCodes.length === 0) status = 'NOT_COVERED';
    else status = 'PARTIAL';

    return {
      status,
      checkedAt,
      requiredCountryCodes,
      coveredCountryCodes,
      uncoveredCountryCodes,
      countries,
      licenseIds: Array.from(usedLicenseIds).sort(),
      blockers,
      warnings,
      attributionTextsRu: Array.from(new Set(attributionTextsRu)),
    };
  }

  private evaluateCountry(
    countryCode: string,
    context: {
      languageCode: string | null;
      requiredMediaFormats: RightsLicenseMediaFormat[];
      licenses: RightsLicenseRecord[];
      at: Date;
    },
  ): CountryCoverageResult {
    const { languageCode, requiredMediaFormats, licenses, at } = context;
    const coveringLicenseIds: string[] = [];
    const failures: LicenseIssue[] = [];

    for (const license of licenses) {
      if (!this.coversCountry(license, countryCode)) continue;

      const failure = this.rejectionFor(license, {
        countryCode,
        languageCode,
        requiredMediaFormats,
        at,
      });
      if (failure) failures.push(failure);
      else coveringLicenseIds.push(license.id);
    }

    if (coveringLicenseIds.length > 0) {
      return { countryCode, covered: true, licenseIds: coveringLicenseIds, issues: [] };
    }

    const issue =
      this.mostSpecificIssue(failures) ??
      ({
        code: 'LICENSE_MISSING_FOR_COUNTRY',
        severity: 'BLOCKER',
        messageRu: `Для страны ${countryCode} нет действующей лицензии, покрывающей язык и формат публикации.`,
        countryCode,
      } as LicenseIssue);

    return { countryCode, covered: false, licenseIds: [], issues: [issue] };
  }

  private rejectionFor(
    license: RightsLicenseRecord,
    context: {
      countryCode: string;
      languageCode: string | null;
      requiredMediaFormats: RightsLicenseMediaFormat[];
      at: Date;
    },
  ): LicenseIssue | null {
    const { countryCode, languageCode, requiredMediaFormats, at } = context;
    const base = { severity: 'BLOCKER' as const, licenseId: license.id, countryCode };
    const effective = this.effectiveStatus(license, at);

    if (effective === RightsLicenseStatus.REVOKED) {
      return {
        ...base,
        code: 'LICENSE_REVOKED',
        messageRu: `Лицензия «${license.title}» отозвана — публикация в стране ${countryCode} невозможна.`,
      };
    }
    if (effective === RightsLicenseStatus.EXPIRED) {
      return {
        ...base,
        code: 'LICENSE_EXPIRED',
        messageRu: `Срок действия лицензии «${license.title}» истёк — публикация в стране ${countryCode} невозможна.`,
      };
    }
    if (license.effectiveFrom && license.effectiveFrom.getTime() > at.getTime()) {
      return {
        ...base,
        code: 'LICENSE_NOT_YET_EFFECTIVE',
        messageRu: `Лицензия «${license.title}» ещё не вступила в силу — публикация в стране ${countryCode} невозможна.`,
      };
    }
    if (effective !== RightsLicenseStatus.ACTIVE) {
      return {
        ...base,
        code: 'LICENSE_STATUS_NOT_ACTIVE',
        messageRu: `Лицензия «${license.title}» не активна (статус ${effective}) — публикация в стране ${countryCode} невозможна.`,
      };
    }
    if (!this.coversLanguage(license, languageCode)) {
      return {
        ...base,
        code: 'LICENSE_SCOPE_LANGUAGE_MISMATCH',
        messageRu: `Лицензия «${license.title}» не покрывает язык публикации для страны ${countryCode}.`,
      };
    }
    if (!this.coversMediaFormats(license, requiredMediaFormats)) {
      return {
        ...base,
        code: 'LICENSE_SCOPE_MEDIA_MISMATCH',
        messageRu: `Лицензия «${license.title}» не покрывает формат публикации для страны ${countryCode}.`,
      };
    }
    return null;
  }

  private mostSpecificIssue(issues: LicenseIssue[]): LicenseIssue | null {
    for (const code of ISSUE_CODE_PRIORITY) {
      const match = issues.find((issue) => issue.code === code);
      if (match) return match;
    }
    return issues[0] ?? null;
  }

  private isExpiringSoon(license: RightsLicenseRecord, at: Date): boolean {
    if (license.isPerpetual || !license.expiresAt) return false;
    if (!this.isActiveAt(license, at)) return false;
    const daysLeft = (license.expiresAt.getTime() - at.getTime()) / MS_PER_DAY;
    return daysLeft >= 0 && daysLeft <= EXPIRING_SOON_DAYS;
  }

  // ---------------------------------------------------------------------------
  // Persistence-backed entry points
  // ---------------------------------------------------------------------------

  /**
   * Licenses linked to the profile itself or to anything owned by it — components,
   * their per-country assessments, territory decisions and the source edition.
   */
  async loadLicensesForProfile(rightsProfileId: string): Promise<RightsLicenseRecord[]> {
    const links = await this.linkDelegate.findMany({
      where: {
        OR: [
          { rightsProfileId },
          { rightsComponent: { rightsProfileId } },
          { componentTerritoryAssessment: { rightsComponent: { rightsProfileId } } },
          { territoryDecision: { rightsProfileId } },
          { sourceEdition: { rightsProfileId } },
        ],
      },
      select: { rightsLicenseId: true },
    });
    return this.loadLicensesByIds(links.map((link) => link.rightsLicenseId));
  }

  /** Licenses linked directly to the version plus everything reachable from its profile. */
  async loadLicensesForVersion(bookVersionId: string): Promise<RightsLicenseRecord[]> {
    const version = await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: { rightsProfileId: true },
    });

    const links = await this.linkDelegate.findMany({
      where: { bookVersionId },
      select: { rightsLicenseId: true },
    });
    const direct = await this.loadLicensesByIds(links.map((link) => link.rightsLicenseId));

    if (!version?.rightsProfileId) return direct;

    const fromProfile = await this.loadLicensesForProfile(version.rightsProfileId);
    return this.dedupeById([...direct, ...fromProfile]);
  }

  private async loadLicensesByIds(ids: string[]): Promise<RightsLicenseRecord[]> {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0) return [];
    return this.licenseDelegate.findMany({ where: { id: { in: uniqueIds } } });
  }

  private dedupeById(licenses: RightsLicenseRecord[]): RightsLicenseRecord[] {
    const byId = new Map<string, RightsLicenseRecord>();
    for (const license of licenses) {
      if (!byId.has(license.id)) byId.set(license.id, license);
    }
    return Array.from(byId.values());
  }

  async evaluateVersionCoverage(bookVersionId: string): Promise<LicenseCoverageResult> {
    const version = (await this.prisma.bookVersion.findUnique({
      where: { id: bookVersionId },
      select: {
        id: true,
        language: true,
        type: true,
        rightsProfileId: true,
      },
    })) as VersionCoverageContext | null;

    const at = new Date();
    if (!version) {
      return this.evaluateCoverage({
        requiredCountryCodes: [],
        languageCode: null,
        requiredMediaFormats: [],
        licenses: [],
        at,
      });
    }

    // WP-2.4 / R8-03: `rightsLicenseRequiredCountryCodes` on the version is written once at book
    // creation, so a market that a later review moved to LICENSE_REQUIRED was never checked for
    // coverage. The requirement is resolved from the clearance in force; coverage itself was
    // already live.
    const clearance = await this.clearanceResolver.resolveForVersion(bookVersionId);
    const licenses = await this.loadLicensesForVersion(bookVersionId);
    const hasTranslationComponent = version.rightsProfileId
      ? await this.hasTranslationComponent(version.rightsProfileId)
      : false;

    return this.evaluateCoverage({
      requiredCountryCodes: clearance.licenseRequiredCountryCodes,
      languageCode: version.language,
      requiredMediaFormats: this.mediaFormatsForVersionType(version.type),
      licenses,
      at,
      hasTranslationComponent,
    });
  }

  async evaluateProfileCoverage(rightsProfileId: string): Promise<LicenseCoverageResult> {
    const territoryDecisionDelegate = (this.prisma as unknown as Record<string, unknown>)[
      'territoryDecision'
    ] as TerritoryDecisionDelegate;

    const decisions = await territoryDecisionDelegate.findMany({
      where: {
        rightsProfileId,
        finalStatus: { in: LICENSE_RELEVANT_TERRITORY_STATUSES },
      },
      select: { countryCode: true },
    });

    const licenses = await this.loadLicensesForProfile(rightsProfileId);

    return this.evaluateCoverage({
      requiredCountryCodes: decisions.map((decision) => decision.countryCode),
      languageCode: null,
      requiredMediaFormats: [],
      licenses,
      at: new Date(),
      hasTranslationComponent: await this.hasTranslationComponent(rightsProfileId),
    });
  }

  private async hasTranslationComponent(rightsProfileId: string): Promise<boolean> {
    const components = (await this.prisma.rightsComponent.findMany({
      where: { rightsProfileId, componentType: 'TRANSLATION' },
      select: { componentType: true },
    })) as unknown as RightsComponentRow[];
    return components.length > 0;
  }
}
