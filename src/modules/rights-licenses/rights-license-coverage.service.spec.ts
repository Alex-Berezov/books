import { PrismaService } from '../../prisma/prisma.service';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import {
  RightsLicenseMediaFormat,
  RightsLicenseRecord,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from './rights-license-interface';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

const makeLicense = (overrides: Partial<RightsLicenseRecord> = {}): RightsLicenseRecord => ({
  id: 'lic-1',
  licenseKey: 'license:test',
  licenseType: RightsLicenseType.DIRECT_LICENSE,
  status: RightsLicenseStatus.ACTIVE,
  title: 'Тестовая лицензия',
  licensor: 'Test Licensor',
  licensee: null,
  rightsHolder: null,
  referenceNumber: null,
  grantedAt: null,
  effectiveFrom: null,
  expiresAt: null,
  isPerpetual: false,
  territoryScope: RightsLicenseTerritoryScope.COUNTRY_LIST,
  countryCodes: ['ES'],
  excludedCountryCodes: null,
  languageCodes: null,
  mediaFormats: null,
  commercialUseAllowed: true,
  modificationAllowed: false,
  translationAllowed: false,
  sublicensingAllowed: false,
  attributionRequired: false,
  requiredAttributionText: null,
  exclusive: false,
  revocable: true,
  revokedAt: null,
  revokedByUserId: null,
  revocationReasonRu: null,
  royaltyTermsRu: null,
  otherConditionsRu: null,
  notesRu: null,
  documentStorageKey: null,
  documentSha256: null,
  documentUrl: null,
  documentMediaAssetId: null,
  sourceEvidenceIds: null,
  confidence: null,
  createdByUserId: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe('RightsLicenseCoverageService', () => {
  let service: RightsLicenseCoverageService;

  beforeEach(() => {
    const prisma = {
      bookVersion: { findUnique: jest.fn() },
      rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
      rightsLicense: { findMany: jest.fn().mockResolvedValue([]) },
      rightsLicenseLink: { findMany: jest.fn().mockResolvedValue([]) },
      territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
    };
    service = new RightsLicenseCoverageService(prisma as unknown as PrismaService);
  });

  describe('effectiveStatus', () => {
    it('returns EXPIRED when expiresAt is in the past', () => {
      const license = makeLicense({ expiresAt: daysFromNow(-1) });
      expect(service.effectiveStatus(license, NOW)).toBe(RightsLicenseStatus.EXPIRED);
    });

    it('returns PENDING when effectiveFrom is in the future', () => {
      const license = makeLicense({ effectiveFrom: daysFromNow(10) });
      expect(service.effectiveStatus(license, NOW)).toBe(RightsLicenseStatus.PENDING);
    });

    it('returns REVOKED when revokedAt is set even if status is ACTIVE', () => {
      const license = makeLicense({ revokedAt: daysFromNow(-5) });
      expect(service.effectiveStatus(license, NOW)).toBe(RightsLicenseStatus.REVOKED);
    });

    it('keeps a perpetual license ACTIVE without an expiry date', () => {
      const license = makeLicense({ isPerpetual: true, expiresAt: null });
      expect(service.effectiveStatus(license, NOW)).toBe(RightsLicenseStatus.ACTIVE);
      expect(service.isActiveAt(license, NOW)).toBe(true);
    });
  });

  describe('coversCountry', () => {
    it('WORLDWIDE covers any country', () => {
      const license = makeLicense({
        territoryScope: RightsLicenseTerritoryScope.WORLDWIDE,
        countryCodes: null,
      });
      expect(service.coversCountry(license, 'JP')).toBe(true);
    });

    it('COUNTRY_LIST compares case-insensitively', () => {
      const license = makeLicense({ countryCodes: ['es'] });
      expect(service.coversCountry(license, 'ES')).toBe(true);
      expect(service.coversCountry(license, 'es')).toBe(true);
    });

    it('EXCEPT_COUNTRY_LIST does not cover an excluded country', () => {
      const license = makeLicense({
        territoryScope: RightsLicenseTerritoryScope.EXCEPT_COUNTRY_LIST,
        countryCodes: null,
        excludedCountryCodes: ['US'],
      });
      expect(service.coversCountry(license, 'US')).toBe(false);
      expect(service.coversCountry(license, 'ES')).toBe(true);
    });

    it('UNKNOWN covers nothing and raises a warning', () => {
      const license = makeLicense({
        territoryScope: RightsLicenseTerritoryScope.UNKNOWN,
        countryCodes: null,
      });
      expect(service.coversCountry(license, 'ES')).toBe(false);

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });
      expect(result.warnings.some((w) => w.code === 'LICENSE_TERRITORY_SCOPE_UNKNOWN')).toBe(true);
    });
  });

  describe('coversLanguage / coversMediaFormats', () => {
    it('an empty languageCodes list covers every language', () => {
      const license = makeLicense({ languageCodes: null });
      expect(service.coversLanguage(license, 'ru')).toBe(true);
    });

    it('reports LICENSE_SCOPE_MEDIA_MISMATCH for an audio version under a text-only license', () => {
      const license = makeLicense({ mediaFormats: [RightsLicenseMediaFormat.TEXT_ONLINE] });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: null,
        requiredMediaFormats: service.mediaFormatsForVersionType('audio'),
        licenses: [license],
        at: NOW,
      });

      expect(result.status).toBe('NOT_COVERED');
      expect(result.blockers[0].code).toBe('LICENSE_SCOPE_MEDIA_MISMATCH');
    });
  });

  describe('evaluateCoverage', () => {
    it('returns COVERED when every required country is covered', () => {
      const license = makeLicense({ countryCodes: ['ES', 'MX'] });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES', 'MX'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });

      expect(result.status).toBe('COVERED');
      expect(result.coveredCountryCodes).toEqual(['ES', 'MX']);
      expect(result.uncoveredCountryCodes).toEqual([]);
      expect(result.licenseIds).toEqual(['lic-1']);
      expect(result.blockers).toEqual([]);
    });

    it('returns PARTIAL and lists the uncovered countries', () => {
      const license = makeLicense({ countryCodes: ['ES'] });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES', 'MX'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });

      expect(result.status).toBe('PARTIAL');
      expect(result.coveredCountryCodes).toEqual(['ES']);
      expect(result.uncoveredCountryCodes).toEqual(['MX']);
      expect(result.blockers.some((b) => b.code === 'LICENSE_MISSING_FOR_COUNTRY')).toBe(true);
    });

    it('returns NOT_REQUIRED when no country needs a license', () => {
      const result = service.evaluateCoverage({
        requiredCountryCodes: [],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [makeLicense()],
        at: NOW,
      });

      expect(result.status).toBe('NOT_REQUIRED');
      expect(result.blockers).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('prefers LICENSE_REVOKED over LICENSE_MISSING_FOR_COUNTRY', () => {
      const revoked = makeLicense({ id: 'lic-revoked', revokedAt: daysFromNow(-2) });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [revoked],
        at: NOW,
      });

      expect(result.blockers).toHaveLength(1);
      expect(result.blockers[0].code).toBe('LICENSE_REVOKED');
    });

    it('warns LICENSE_EXPIRING_SOON at 30 days but not at 200 days', () => {
      const soon = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [makeLicense({ expiresAt: daysFromNow(30) })],
        at: NOW,
      });
      expect(soon.warnings.some((w) => w.code === 'LICENSE_EXPIRING_SOON')).toBe(true);

      const later = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [makeLicense({ expiresAt: daysFromNow(200) })],
        at: NOW,
      });
      expect(later.warnings.some((w) => w.code === 'LICENSE_EXPIRING_SOON')).toBe(false);
    });

    it('collects attribution text only from covering licenses that require it', () => {
      const covering = makeLicense({
        id: 'lic-covering',
        countryCodes: ['ES'],
        attributionRequired: true,
        requiredAttributionText: '© Penguin Random House, 2019',
      });
      const unrelated = makeLicense({
        id: 'lic-unrelated',
        countryCodes: ['JP'],
        attributionRequired: true,
        requiredAttributionText: '© Другой правообладатель',
      });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [covering, unrelated],
        at: NOW,
      });

      expect(result.attributionTextsRu).toEqual(['© Penguin Random House, 2019']);
      expect(result.warnings.some((w) => w.code === 'LICENSE_ATTRIBUTION_REQUIRED')).toBe(true);
    });

    it('reports LICENSE_SCOPE_LANGUAGE_MISMATCH when the language is not covered', () => {
      const license = makeLicense({ languageCodes: ['es'] });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'ru',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });

      expect(result.blockers[0].code).toBe('LICENSE_SCOPE_LANGUAGE_MISMATCH');
    });

    it('reports LICENSE_NOT_YET_EFFECTIVE for a future effectiveFrom', () => {
      const license = makeLicense({ effectiveFrom: daysFromNow(15) });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });

      expect(result.blockers[0].code).toBe('LICENSE_NOT_YET_EFFECTIVE');
    });

    it('reports LICENSE_STATUS_NOT_ACTIVE for a DRAFT license', () => {
      const license = makeLicense({ status: RightsLicenseStatus.DRAFT });

      const result = service.evaluateCoverage({
        requiredCountryCodes: ['ES'],
        languageCode: 'es',
        requiredMediaFormats: [],
        licenses: [license],
        at: NOW,
      });

      expect(result.blockers[0].code).toBe('LICENSE_STATUS_NOT_ACTIVE');
    });
  });

  describe('mediaFormatsForVersionType', () => {
    it('maps version types to the formats a license must cover', () => {
      expect(service.mediaFormatsForVersionType('text')).toEqual([
        RightsLicenseMediaFormat.TEXT_ONLINE,
        RightsLicenseMediaFormat.TEXT_DOWNLOAD,
      ]);
      expect(service.mediaFormatsForVersionType('audio')).toEqual([
        RightsLicenseMediaFormat.AUDIO_STREAMING,
        RightsLicenseMediaFormat.AUDIO_DOWNLOAD,
      ]);
      expect(service.mediaFormatsForVersionType('referral')).toEqual([]);
    });
  });
});
