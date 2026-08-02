import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRightsLicenseDto } from './dto/create-rights-license.dto';
import { RightsClearanceResolverService } from '../rights-clearance/rights-clearance-resolver.service';
import { RightsLicenseCoverageService } from './rights-license-coverage.service';
import { RightsLicensesService } from './rights-licenses.service';
import {
  RightsLicenseLinkType,
  RightsLicenseRecord,
  RightsLicenseStatus,
  RightsLicenseTerritoryScope,
  RightsLicenseType,
} from './rights-license-interface';

const NOW = new Date('2026-07-28T00:00:00.000Z');
const daysFromNow = (days: number) => new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000);

const makeRecord = (overrides: Partial<RightsLicenseRecord> = {}): RightsLicenseRecord => ({
  id: 'lic-1',
  licenseKey: null,
  licenseType: RightsLicenseType.DIRECT_LICENSE,
  status: RightsLicenseStatus.DRAFT,
  title: 'Тестовая лицензия',
  licensor: 'Test Licensor',
  licensee: null,
  rightsHolder: null,
  referenceNumber: null,
  grantedAt: null,
  effectiveFrom: null,
  expiresAt: null,
  isPerpetual: false,
  territoryScope: RightsLicenseTerritoryScope.WORLDWIDE,
  countryCodes: null,
  excludedCountryCodes: null,
  languageCodes: null,
  mediaFormats: null,
  commercialUseAllowed: false,
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

const validDto = (overrides: Partial<CreateRightsLicenseDto> = {}): CreateRightsLicenseDto => ({
  title: 'Тестовая лицензия',
  licensor: 'Test Licensor',
  territoryScope: RightsLicenseTerritoryScope.WORLDWIDE,
  ...overrides,
});

interface PrismaStub {
  rightsLicense: Record<string, jest.Mock>;
  rightsLicenseLink: Record<string, jest.Mock>;
  rightsLicenseEvent: Record<string, jest.Mock>;
  rightsProfile: Record<string, jest.Mock>;
  bookVersion: Record<string, jest.Mock>;
  mediaAsset: Record<string, jest.Mock>;
  rightsComponent: Record<string, jest.Mock>;
  territoryDecision: Record<string, jest.Mock>;
}

const createPrismaStub = (): PrismaStub => ({
  rightsLicense: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn().mockResolvedValue(0),
  },
  rightsLicenseLink: {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    create: jest.fn(),
    delete: jest.fn(),
  },
  rightsLicenseEvent: {
    findMany: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({}),
  },
  rightsProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
  bookVersion: { findUnique: jest.fn().mockResolvedValue(null) },
  mediaAsset: { findUnique: jest.fn().mockResolvedValue(null) },
  rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
  territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
});

describe('RightsLicensesService', () => {
  let service: RightsLicensesService;
  let prisma: PrismaStub;

  beforeEach(() => {
    prisma = createPrismaStub();
    const coverage = new RightsLicenseCoverageService(
      prisma as unknown as PrismaService,
      new RightsClearanceResolverService(prisma as unknown as PrismaService),
    );
    service = new RightsLicensesService(prisma as unknown as PrismaService, coverage);
  });

  describe('create', () => {
    it('creates a license and records a CREATED event', async () => {
      prisma.rightsLicense.create.mockResolvedValue(makeRecord());

      const result = await service.create(validDto(), 'user-1');

      expect(prisma.rightsLicense.create).toHaveBeenCalled();
      expect(prisma.rightsLicenseEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'CREATED', createdByUserId: 'user-1' }),
        }),
      );
      expect(result.id).toBe('lic-1');
    });

    it('records an ACTIVATED event when the license is created active', async () => {
      prisma.rightsLicense.create.mockResolvedValue(
        makeRecord({ status: RightsLicenseStatus.ACTIVE }),
      );

      await service.create(validDto({ status: RightsLicenseStatus.ACTIVE }), 'user-1');

      const eventTypes = prisma.rightsLicenseEvent.create.mock.calls.map(
        (call) => (call[0] as { data: { eventType: string } }).data.eventType,
      );
      expect(eventTypes).toContain('ACTIVATED');
    });

    it('rejects COUNTRY_LIST scope without country codes', async () => {
      await expect(
        service.create(
          validDto({ territoryScope: RightsLicenseTerritoryScope.COUNTRY_LIST }),
          'user-1',
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects a perpetual license that also has an expiry date', async () => {
      await expect(
        service.create(
          validDto({ isPerpetual: true, expiresAt: daysFromNow(365).toISOString() }),
          'user-1',
        ),
      ).rejects.toThrow('PERPETUAL_WITH_EXPIRY');
    });

    it('rejects expiresAt earlier than effectiveFrom', async () => {
      await expect(
        service.create(
          validDto({
            effectiveFrom: daysFromNow(100).toISOString(),
            expiresAt: daysFromNow(10).toISOString(),
          }),
          'user-1',
        ),
      ).rejects.toThrow('INVALID_LICENSE_PERIOD');
    });

    it('rejects attributionRequired without attribution text', async () => {
      await expect(
        service.create(validDto({ attributionRequired: true }), 'user-1'),
      ).rejects.toThrow('ATTRIBUTION_TEXT_REQUIRED');
    });

    it('rejects activating an already expired license', async () => {
      await expect(
        service.create(
          validDto({
            status: RightsLicenseStatus.ACTIVE,
            expiresAt: new Date('2020-01-01T00:00:00.000Z').toISOString(),
          }),
          'user-1',
        ),
      ).rejects.toThrow('CANNOT_ACTIVATE_EXPIRED_LICENSE');
    });

    it('rejects a malformed documentSha256', async () => {
      await expect(
        service.create(validDto({ documentSha256: 'not-a-hash' }), 'user-1'),
      ).rejects.toThrow('INVALID_DOCUMENT_SHA256');
    });
  });

  describe('update', () => {
    it('refuses to update a revoked license beyond its notes', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(
        makeRecord({ status: RightsLicenseStatus.REVOKED, revokedAt: NOW }),
      );

      await expect(service.update('lic-1', { title: 'Новое имя' }, 'user-1')).rejects.toThrow(
        'LICENSE_REVOKED_IMMUTABLE',
      );
    });
  });

  describe('revoke', () => {
    it('requires a reason', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord());

      await expect(service.revoke('lic-1', { reasonRu: '   ' }, 'user-1')).rejects.toThrow(
        'REVOCATION_REASON_REQUIRED',
      );
    });

    it('sets revocation fields and records a REVOKED event', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord());
      prisma.rightsLicense.update.mockResolvedValue(
        makeRecord({ status: RightsLicenseStatus.REVOKED, revokedAt: NOW }),
      );

      const result = await service.revoke('lic-1', { reasonRu: 'Договор расторгнут' }, 'user-1');

      expect(prisma.rightsLicense.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: RightsLicenseStatus.REVOKED,
            revokedByUserId: 'user-1',
            revocationReasonRu: 'Договор расторгнут',
          }),
        }),
      );
      expect(result.warnings).toEqual([]);
    });

    it('warns when revoking a license marked irrevocable', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord({ revocable: false }));
      prisma.rightsLicense.update.mockResolvedValue(
        makeRecord({ revocable: false, status: RightsLicenseStatus.REVOKED, revokedAt: NOW }),
      );

      const result = await service.revoke('lic-1', { reasonRu: 'Причина' }, 'user-1');

      expect(result.warnings).toHaveLength(1);
      expect(prisma.rightsLicenseEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ payload: { wasIrrevocable: true } }),
        }),
      );
    });
  });

  describe('link / unlink', () => {
    it('rejects a target id that does not match the link type', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord());

      await expect(
        service.link(
          'lic-1',
          { linkType: RightsLicenseLinkType.RIGHTS_PROFILE, bookVersionId: 'version-1' },
          'user-1',
        ),
      ).rejects.toThrow('LINK_TARGET_MISMATCH');
    });

    it('returns the existing link instead of creating a duplicate', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord());
      prisma.rightsLicenseLink.findFirst.mockResolvedValue({
        id: 'link-1',
        rightsLicenseId: 'lic-1',
        linkType: RightsLicenseLinkType.RIGHTS_PROFILE,
        rightsProfileId: 'profile-1',
        rightsComponentId: null,
        componentTerritoryAssessmentId: null,
        territoryDecisionId: null,
        sourceEditionId: null,
        rightsEvidenceId: null,
        bookVersionId: null,
        coversCountryCodes: null,
        notesRu: null,
        createdByUserId: null,
        createdAt: NOW,
        updatedAt: NOW,
      });

      const result = await service.link(
        'lic-1',
        { linkType: RightsLicenseLinkType.RIGHTS_PROFILE, rightsProfileId: 'profile-1' },
        'user-1',
      );

      expect(result.id).toBe('link-1');
      expect(prisma.rightsLicenseLink.create).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when unlinking a link of another license', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(makeRecord());
      prisma.rightsLicenseLink.findFirst.mockResolvedValue(null);

      await expect(service.unlink('lic-1', 'link-other', 'user-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  /**
   * WP-10.1 (R0-01): `RightsLicenseLink` — единственная запись о том, какую страну, компонент
   * или версию покрывала лицензия. По решению WP-0.4 связь удаляется физически, поэтому
   * отвязка обязана оставить событие, по которому связь восстанавливается, и записать его
   * в той же транзакции, что и удаление.
   *
   * Двойник ниже имитирует транзакцию: запись через tx-клиент попадает в «БД» только после
   * успешного завершения коллбэка, поэтому тест на откат проверяет атомарность, а не вызов.
   */
  describe('unlink — след отвязки лицензии (WP-10.1)', () => {
    interface Write {
      model: string;
      data: Record<string, unknown>;
    }

    const linkRow = {
      id: 'link-1',
      rightsLicenseId: 'lic-1',
      linkType: RightsLicenseLinkType.TERRITORY_DECISION,
      rightsProfileId: null,
      rightsComponentId: null,
      componentTerritoryAssessmentId: null,
      territoryDecisionId: 'td-9',
      sourceEditionId: null,
      rightsEvidenceId: null,
      bookVersionId: null,
      coversCountryCodes: ['DE', 'FR'],
      notesRu: 'Покрывает Германию и Францию',
      createdByUserId: 'user-0',
      createdAt: NOW,
      updatedAt: NOW,
    };

    const createDouble = (onEventCreate?: () => void) => {
      const committed: Write[] = [];

      const clientFor = (buffer: Write[]) => ({
        rightsLicense: {
          findUnique: jest.fn().mockResolvedValue(makeRecord()),
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(null),
          create: jest.fn(),
          update: jest.fn(),
          count: jest.fn().mockResolvedValue(0),
        },
        rightsLicenseLink: {
          findMany: jest.fn().mockResolvedValue([]),
          findFirst: jest.fn().mockResolvedValue(linkRow),
          create: jest.fn(),
          delete: jest.fn((args: { where: { id: string } }) => {
            buffer.push({ model: 'rightsLicenseLink.delete', data: args.where });
            return Promise.resolve(linkRow);
          }),
        },
        rightsLicenseEvent: {
          findMany: jest.fn().mockResolvedValue([]),
          create: jest.fn((args: { data: Record<string, unknown> }) => {
            onEventCreate?.();
            buffer.push({ model: 'rightsLicenseEvent.create', data: args.data });
            return Promise.resolve(args.data);
          }),
        },
        rightsProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
        bookVersion: { findUnique: jest.fn().mockResolvedValue(null) },
        mediaAsset: { findUnique: jest.fn().mockResolvedValue(null) },
        rightsComponent: { findMany: jest.fn().mockResolvedValue([]) },
        territoryDecision: { findMany: jest.fn().mockResolvedValue([]) },
      });

      const base = clientFor(committed);

      const client = {
        ...base,
        $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          const pending: Write[] = [];
          const result = await callback(clientFor(pending));
          committed.push(...pending);
          return result;
        },
      };

      return { committed, client };
    };

    const buildService = (client: unknown): RightsLicensesService =>
      new RightsLicensesService(
        client as PrismaService,
        new RightsLicenseCoverageService(
          client as PrismaService,
          new RightsClearanceResolverService(client as PrismaService),
        ),
      );

    it('пишет событие UNLINKED, по которому восстанавливается обе стороны связи', async () => {
      const double = createDouble();

      await buildService(double.client).unlink('lic-1', 'link-1', 'user-42');

      const events = double.committed.filter(
        (write) => write.model === 'rightsLicenseEvent.create',
      );
      expect(events).toHaveLength(1);
      expect(events[0].data).toEqual(
        expect.objectContaining({
          rightsLicenseId: 'lic-1',
          eventType: 'UNLINKED',
          createdByUserId: 'user-42',
        }),
      );
      expect(events[0].data.payload).toEqual(
        expect.objectContaining({
          linkId: 'link-1',
          linkType: RightsLicenseLinkType.TERRITORY_DECISION,
          territoryDecisionId: 'td-9',
          coversCountryCodes: ['DE', 'FR'],
          linkedAt: NOW.toISOString(),
        }),
      );
    });

    it('откат транзакции не оставляет ни удалённой связи, ни события', async () => {
      const double = createDouble(() => {
        throw new Error('journal write failed');
      });

      await expect(
        buildService(double.client).unlink('lic-1', 'link-1', 'user-42'),
      ).rejects.toThrow('journal write failed');

      expect(double.committed).toHaveLength(0);
    });
  });

  describe('findOne', () => {
    it('throws NotFoundException for an unknown license', async () => {
      prisma.rightsLicense.findUnique.mockResolvedValue(null);

      await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
