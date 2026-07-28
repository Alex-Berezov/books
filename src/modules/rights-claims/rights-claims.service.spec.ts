import { BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateRightsClaimDto } from './dto/create-rights-claim.dto';
import { RightsClaimsService } from './rights-claims.service';
import {
  ClaimBlockScope,
  RightsClaimAccessBlockRecord,
  RightsClaimBlockStatus,
  RightsClaimEventType,
  RightsClaimRecord,
  RightsClaimResolution,
  RightsClaimSeverity,
  RightsClaimStatus,
  RightsClaimType,
  RightsClaimantType,
  RightsClaimChannel,
} from './rights-claim-interface';

const NOW = new Date('2026-07-28T12:00:00.000Z');

const createClaim = (overrides: Partial<RightsClaimRecord> = {}): RightsClaimRecord => ({
  id: 'claim-1',
  claimNumber: 'CLM-2026-000001',
  claimType: RightsClaimType.DMCA_TAKEDOWN,
  status: RightsClaimStatus.RECEIVED,
  severity: RightsClaimSeverity.MEDIUM,
  channel: RightsClaimChannel.EMAIL,
  receivedAt: new Date('2026-07-27T12:00:00.000Z'),
  deadlineAt: null,
  resolvedAt: null,
  closedAt: null,
  claimantName: 'Acme Publishing',
  claimantType: RightsClaimantType.PUBLISHER,
  claimantOrganization: null,
  claimantEmail: null,
  claimantPhone: null,
  claimantAddress: null,
  claimantIsAuthorized: true,
  claimantPersonId: null,
  bookId: 'book-1',
  bookVersionId: 'version-1',
  rightsProfileId: null,
  rightsIntakeId: null,
  mediaAssetId: null,
  affectedCountryCodes: [],
  affectedLanguages: [],
  claimedWorkTitle: null,
  claimedWorkAuthor: null,
  claimedRightsDescriptionRu: null,
  descriptionRu: 'Нарушение авторских прав на текст',
  infringingUrls: [],
  goodFaithStatement: true,
  swornStatement: false,
  originalNoticeText: null,
  originalNoticeUrl: null,
  assignedToUserId: null,
  internalNotesRu: null,
  blocksPublication: true,
  blocksPublicationOverrideReasonRu: null,
  requiresLawyerReview: false,
  responseSentAt: null,
  responseChannel: null,
  responseTextRu: null,
  responseByUserId: null,
  counterNoticeReceivedAt: null,
  counterNoticeClaimantName: null,
  counterNoticeTextRu: null,
  resolution: null,
  resolutionNotesRu: null,
  resolvedByUserId: null,
  parentClaimId: null,
  createdByUserId: 'user-1',
  createdAt: new Date('2026-07-27T12:00:00.000Z'),
  updatedAt: new Date('2026-07-27T12:00:00.000Z'),
  ...overrides,
});

const createBlock = (
  overrides: Partial<RightsClaimAccessBlockRecord> = {},
): RightsClaimAccessBlockRecord => ({
  id: 'block-1',
  rightsClaimId: 'claim-1',
  bookId: 'book-1',
  bookVersionId: 'version-1',
  scope: ClaimBlockScope.LANGUAGE_EDITION,
  countryCode: null,
  status: RightsClaimBlockStatus.ACTIVE,
  reasonRu: 'Претензия правообладателя',
  appliedAt: new Date('2026-07-28T10:00:00.000Z'),
  appliedByUserId: 'user-1',
  expiresAt: null,
  liftedAt: null,
  liftedByUserId: null,
  liftReasonRu: null,
  createdAt: new Date('2026-07-28T10:00:00.000Z'),
  updatedAt: new Date('2026-07-28T10:00:00.000Z'),
  ...overrides,
});

interface PrismaStub {
  rightsClaim: Record<string, jest.Mock>;
  rightsClaimComponent: Record<string, jest.Mock>;
  rightsClaimAccessBlock: Record<string, jest.Mock>;
  rightsClaimAttachment: Record<string, jest.Mock>;
  rightsClaimEvent: Record<string, jest.Mock>;
  bookVersion: Record<string, jest.Mock>;
  book: Record<string, jest.Mock>;
  rightsProfile: Record<string, jest.Mock>;
  rightsIntake: Record<string, jest.Mock>;
  rightsComponent: Record<string, jest.Mock>;
  mediaAsset: Record<string, jest.Mock>;
  user: Record<string, jest.Mock>;
  $transaction: <T>(callback: (transaction: PrismaStub) => Promise<T>) => Promise<T>;
}

const createPrismaStub = (): PrismaStub => {
  const stub = {
    rightsClaim: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(createClaim()),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          createClaim({ claimNumber: data.claimNumber as string }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          createClaim(data as Partial<RightsClaimRecord>),
        ),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsClaimComponent: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: 'claim-component-1',
        createdAt: NOW,
        ...data,
      })),
      delete: jest.fn().mockResolvedValue({}),
    },
    rightsClaimAccessBlock: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) =>
          createBlock({ id: `block-${(data.countryCode as string) ?? 'ww'}`, ...data }),
        ),
      update: jest
        .fn()
        .mockImplementation(({ data }: { data: Record<string, unknown> }) => createBlock(data)),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      count: jest.fn().mockResolvedValue(0),
    },
    rightsClaimAttachment: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
        id: 'attachment-1',
        isDeleted: false,
        removedAt: null,
        removedByUserId: null,
        createdAt: NOW,
        fileName: null,
        mediaAssetId: null,
        storageKey: null,
        url: null,
        sha256: null,
        contentType: null,
        sizeBytes: null,
        notesRu: null,
        ...data,
      })),
      update: jest.fn().mockResolvedValue({}),
    },
    rightsClaimEvent: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
    },
    bookVersion: {
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: 'version-1', bookId: 'book-1', status: 'published' }]),
      findUnique: jest
        .fn()
        .mockResolvedValue({ id: 'version-1', bookId: 'book-1', status: 'published' }),
      update: jest.fn().mockResolvedValue({}),
    },
    book: { findUnique: jest.fn().mockResolvedValue({ id: 'book-1' }) },
    rightsProfile: { findUnique: jest.fn().mockResolvedValue({ id: 'profile-1' }) },
    rightsIntake: { findUnique: jest.fn().mockResolvedValue({ id: 'intake-1' }) },
    rightsComponent: {
      findUnique: jest.fn().mockResolvedValue({ id: 'component-1', rightsProfileId: 'profile-1' }),
    },
    mediaAsset: { findUnique: jest.fn().mockResolvedValue({ id: 'asset-1', isDeleted: false }) },
    user: { findUnique: jest.fn().mockResolvedValue({ id: 'user-2' }) },
    $transaction: async <T>(callback: (transaction: PrismaStub) => Promise<T>): Promise<T> =>
      callback(stub),
  };
  return stub as unknown as PrismaStub;
};

const baseCreateDto = (overrides: Partial<CreateRightsClaimDto> = {}): CreateRightsClaimDto => ({
  claimType: RightsClaimType.DMCA_TAKEDOWN,
  claimantName: 'Acme Publishing',
  descriptionRu: 'Нарушение авторских прав на текст',
  bookVersionId: 'version-1',
  ...overrides,
});

const eventTypes = (prisma: PrismaStub): string[] =>
  prisma.rightsClaimEvent.create.mock.calls.map(
    (call: [{ data: { eventType: string } }]) => call[0].data.eventType,
  );

describe('RightsClaimsService', () => {
  let prisma: PrismaStub;
  let service: RightsClaimsService;

  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(NOW);
    prisma = createPrismaStub();
    service = new RightsClaimsService(prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // --- create -------------------------------------------------------------

  it('generates a claim number of the form CLM-<year>-000001', async () => {
    await service.create(baseCreateDto(), 'user-1');

    expect(prisma.rightsClaim.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ claimNumber: 'CLM-2026-000001' }),
      }),
    );
  });

  it('retries with an incremented counter after a P2002 collision', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.rightsClaim.create
      .mockRejectedValueOnce(conflict)
      .mockImplementationOnce(({ data }: { data: Record<string, unknown> }) =>
        createClaim({ claimNumber: data.claimNumber as string }),
      );

    const claim = await service.create(baseCreateDto(), 'user-1');

    expect(prisma.rightsClaim.create).toHaveBeenCalledTimes(2);
    expect(claim.claimNumber).toBe('CLM-2026-000002');
  });

  it('rejects a claim with neither book nor version', async () => {
    await expect(
      service.create(baseCreateDto({ bookVersionId: undefined }), 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_TARGET_REQUIRED' } });
  });

  it('returns 404 CLAIM_TARGET_NOT_FOUND for a missing version', async () => {
    prisma.bookVersion.findUnique.mockResolvedValue(null);

    await expect(service.create(baseCreateDto(), 'user-1')).rejects.toMatchObject({
      response: { code: 'CLAIM_TARGET_NOT_FOUND' },
    });
  });

  it('rejects a malformed country code', async () => {
    await expect(
      service.create(baseCreateDto({ affectedCountryCodes: ['usa'] }), 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'INVALID_COUNTRY_CODE' } });
  });

  it('rejects a deadline that precedes the received date', async () => {
    await expect(
      service.create(
        baseCreateDto({
          receivedAt: '2026-07-27T12:00:00.000Z',
          deadlineAt: '2026-07-20T12:00:00.000Z',
        }),
        'user-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'DEADLINE_BEFORE_RECEIVED' } });
  });

  it('writes a CREATED event', async () => {
    await service.create(baseCreateDto(), 'user-1');

    expect(eventTypes(prisma)).toContain(RightsClaimEventType.CREATED);
  });

  // --- update -------------------------------------------------------------

  it('requires a reason when publication blocking is switched off', async () => {
    await expect(
      service.update('claim-1', { blocksPublication: false }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'BLOCK_OVERRIDE_REASON_REQUIRED' } });
  });

  it('rejects edits to a closed claim beyond internal notes', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.CLOSED }),
    );

    await expect(
      service.update('claim-1', { severity: RightsClaimSeverity.HIGH }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_CLOSED_IMMUTABLE' } });

    await expect(
      service.update('claim-1', { internalNotesRu: 'Архивная заметка' }, 'user-1'),
    ).resolves.toBeDefined();
  });

  // --- status transitions -------------------------------------------------

  it('rejects an illegal status transition', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.RECEIVED }),
    );

    await expect(
      service.changeStatus('claim-1', { status: RightsClaimStatus.CONTENT_REMOVED }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'INVALID_STATUS_TRANSITION' } });
  });

  it('records a STATUS_CHANGED event with previous and current status', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.RECEIVED }),
    );

    await service.changeStatus('claim-1', { status: RightsClaimStatus.UNDER_REVIEW }, 'user-1');

    const call = prisma.rightsClaimEvent.create.mock.calls.find(
      (entry: [{ data: { eventType: string } }]) =>
        entry[0].data.eventType === String(RightsClaimEventType.STATUS_CHANGED),
    );
    expect(call?.[0].data).toMatchObject({
      previousStatus: RightsClaimStatus.RECEIVED,
      currentStatus: RightsClaimStatus.UNDER_REVIEW,
    });
  });

  // --- access blocks ------------------------------------------------------

  it('rejects an AUDIO block without a version', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(createClaim({ bookVersionId: null }));

    await expect(
      service.applyBlock(
        'claim-1',
        { scope: ClaimBlockScope.AUDIO, reasonRu: 'Претензия' },
        'user-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'BLOCK_SCOPE_REQUIRES_VERSION' } });
  });

  it('creates a single worldwide block when no country is given', async () => {
    const blocks = await service.applyBlock(
      'claim-1',
      { scope: ClaimBlockScope.LANGUAGE_EDITION, reasonRu: 'Претензия' },
      'user-1',
    );

    expect(prisma.rightsClaimAccessBlock.create).toHaveBeenCalledTimes(1);
    expect(prisma.rightsClaimAccessBlock.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ countryCode: null }) }),
    );
    expect(blocks).toHaveLength(1);
  });

  it('creates one block per country', async () => {
    const blocks = await service.applyBlock(
      'claim-1',
      {
        scope: ClaimBlockScope.TEXT_READER,
        countryCodes: ['de', 'FR', 'es'],
        reasonRu: 'Претензия',
      },
      'user-1',
    );

    expect(prisma.rightsClaimAccessBlock.create).toHaveBeenCalledTimes(3);
    expect(blocks.map((block) => block.countryCode)).toEqual(['DE', 'ES', 'FR']);
  });

  it('does not duplicate an existing active block for the same country and scope', async () => {
    prisma.rightsClaimAccessBlock.findFirst.mockResolvedValue(createBlock({ countryCode: 'DE' }));

    await service.applyBlock(
      'claim-1',
      { scope: ClaimBlockScope.TEXT_READER, countryCodes: ['DE'], reasonRu: 'Претензия' },
      'user-1',
    );

    expect(prisma.rightsClaimAccessBlock.create).not.toHaveBeenCalled();
  });

  it('unpublishes a published version and records VERSION_UNPUBLISHED', async () => {
    await service.applyBlock(
      'claim-1',
      {
        scope: ClaimBlockScope.LANGUAGE_EDITION,
        reasonRu: 'Претензия',
        unpublishVersion: true,
      },
      'user-1',
    );

    expect(prisma.bookVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'version-1' }, data: { status: 'draft' } }),
    );
    expect(eventTypes(prisma)).toContain(RightsClaimEventType.VERSION_UNPUBLISHED);
  });

  it('sets rightsClaimBlockActive on the version', async () => {
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([createBlock()]);

    await service.applyBlock(
      'claim-1',
      { scope: ClaimBlockScope.LANGUAGE_EDITION, reasonRu: 'Претензия' },
      'user-1',
    );

    expect(prisma.bookVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ rightsClaimBlockActive: true }),
      }),
    );
  });

  it('requires a reason to lift a block', async () => {
    prisma.rightsClaimAccessBlock.findFirst.mockResolvedValue(createBlock());

    await expect(
      service.liftBlock('claim-1', 'block-1', { liftReasonRu: '' }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'LIFT_REASON_REQUIRED' } });
  });

  it('clears the version flag once no active block remains', async () => {
    prisma.rightsClaimAccessBlock.findFirst.mockResolvedValue(createBlock());
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValue([]);

    await service.liftBlock('claim-1', 'block-1', { liftReasonRu: 'Претензия отозвана' }, 'user-1');

    expect(prisma.bookVersion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { rightsClaimBlockActive: false, rightsClaimBlockAppliedAt: null },
      }),
    );
    expect(eventTypes(prisma)).toContain(RightsClaimEventType.BLOCK_LIFTED);
  });

  // --- resolution ---------------------------------------------------------

  it('rejects a resolution without notes and a repeated resolution', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.UNDER_REVIEW }),
    );

    await expect(
      service.resolve(
        'claim-1',
        { resolution: RightsClaimResolution.NO_ACTION_NEEDED, resolutionNotesRu: '  ' },
        'user-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'RESOLUTION_NOTES_REQUIRED' } });

    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.UNDER_REVIEW, resolvedAt: NOW }),
    );

    await expect(
      service.resolve(
        'claim-1',
        { resolution: RightsClaimResolution.NO_ACTION_NEEDED, resolutionNotesRu: 'Готово' },
        'user-1',
      ),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_ALREADY_RESOLVED' } });
  });

  it('lifts every active block when resolving with liftActiveBlocks', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.UNDER_REVIEW }),
    );
    prisma.rightsClaimAccessBlock.findMany.mockResolvedValueOnce([
      createBlock({ id: 'block-a' }),
      createBlock({ id: 'block-b', countryCode: 'DE' }),
    ]);

    await service.resolve(
      'claim-1',
      {
        resolution: RightsClaimResolution.INVALID_REJECTED,
        resolutionNotesRu: 'Претензия отклонена',
        liftActiveBlocks: true,
      },
      'user-1',
    );

    expect(prisma.rightsClaimAccessBlock.update).toHaveBeenCalledTimes(2);
    expect(prisma.rightsClaimAccessBlock.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: RightsClaimBlockStatus.LIFTED }),
      }),
    );
    expect(eventTypes(prisma)).toContain(RightsClaimEventType.RESOLVED);
  });

  it('reopens only a resolved claim and clears the resolution fields', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.UNDER_REVIEW }),
    );

    await expect(
      service.reopen('claim-1', { reasonRu: 'Новые обстоятельства' }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'CLAIM_NOT_RESOLVED' } });

    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({
        status: RightsClaimStatus.RESOLVED_INVALID,
        resolvedAt: NOW,
        resolution: RightsClaimResolution.INVALID_REJECTED,
      }),
    );

    await service.reopen('claim-1', { reasonRu: 'Новые обстоятельства' }, 'user-1');

    expect(prisma.rightsClaim.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: RightsClaimStatus.UNDER_REVIEW,
          resolvedAt: null,
          resolution: null,
        }),
      }),
    );
    expect(eventTypes(prisma)).toContain(RightsClaimEventType.REOPENED);
  });

  // --- gate evaluation ----------------------------------------------------

  it('evaluates both version-level and book-level claims', async () => {
    prisma.rightsClaim.findMany.mockResolvedValue([
      createClaim({ id: 'claim-1', bookVersionId: 'version-1' }),
      createClaim({
        id: 'claim-2',
        claimNumber: 'CLM-2026-000002',
        bookVersionId: null,
        severity: RightsClaimSeverity.CRITICAL,
      }),
    ]);

    const evaluation = await service.evaluateVersionClaims('version-1');

    expect(prisma.rightsClaim.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          OR: [{ bookVersionId: 'version-1' }, { bookId: 'book-1', bookVersionId: null }],
        },
      }),
    );
    expect(evaluation.activeClaimsCount).toBe(2);
    expect(evaluation.blockingClaimsCount).toBe(2);
    expect(evaluation.criticalClaimsCount).toBe(1);
    expect(evaluation.worstSeverity).toBe(RightsClaimSeverity.CRITICAL);
    expect(evaluation.blockers.some((issue) => issue.code === 'ACTIVE_RIGHTS_CLAIM')).toBe(true);
    expect(
      evaluation.blockers.some((issue) => issue.code === 'CRITICAL_RIGHTS_CLAIM_UNRESOLVED'),
    ).toBe(true);
  });

  // --- attachments --------------------------------------------------------

  it('soft-deletes attachments instead of removing the row', async () => {
    prisma.rightsClaimAttachment.findFirst.mockResolvedValue({
      id: 'attachment-1',
      rightsClaimId: 'claim-1',
      isDeleted: false,
    });

    await service.removeAttachment('claim-1', 'attachment-1', 'user-1');

    expect(prisma.rightsClaimAttachment.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'attachment-1' },
        data: expect.objectContaining({ isDeleted: true, removedByUserId: 'user-1' }),
      }),
    );
    expect(prisma.rightsClaimAttachment.delete).toBeUndefined();
    expect(eventTypes(prisma)).toContain(RightsClaimEventType.ATTACHMENT_REMOVED);
  });

  it('rejects an attachment with no source', async () => {
    await expect(
      service.addAttachment('claim-1', { title: 'Уведомление' }, 'user-1'),
    ).rejects.toMatchObject({ response: { code: 'ATTACHMENT_SOURCE_REQUIRED' } });
  });

  it('throws NotFoundException for an unknown claim', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(null);

    await expect(service.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects work on a closed claim', async () => {
    prisma.rightsClaim.findUnique.mockResolvedValue(
      createClaim({ status: RightsClaimStatus.CLOSED }),
    );

    await expect(
      service.recordResponse('claim-1', { responseTextRu: 'Ответ' }, 'user-1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
