import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContributorRole } from '../persons/person-interface';
import { PersonsService } from '../persons/persons.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { ContributorsService } from './contributors.service';

describe('ContributorsService', () => {
  let service: ContributorsService;

  const mockPerson = {
    id: 'person-1',
    canonicalName: 'Homer',
    sortName: null,
    birthDate: null,
    deathDate: null,
    birthYear: -800,
    deathYear: -750,
    nationalityCountryCode: 'GR',
    publicDomainFromYear: 1900,
    wikidataId: 'Q6691',
    viafId: '224924963',
    isni: null,
    gutenbergAgentId: '705',
    notesRu: 'Легендарный автор.',
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPersonsService = {
    create: jest.fn().mockResolvedValue(mockPerson),
    findAll: jest.fn().mockResolvedValue({ items: [mockPerson], total: 1 }),
    findOne: jest.fn().mockResolvedValue(mockPerson),
    update: jest.fn().mockResolvedValue(mockPerson),
    remove: jest.fn().mockResolvedValue({ id: 'person-1' }),
  };

  const mockPrismaService = {
    rightsProfileContributor: {
      create: jest.fn().mockResolvedValue({ id: 'rpc-1' }),
      findUnique: jest.fn().mockResolvedValue({
        id: 'rpc-1',
        rightsProfileId: 'profile-1',
        rightsComponentId: 'rc-1',
      }),
      delete: jest.fn().mockResolvedValue({ id: 'rpc-1' }),
    },
    rightsProfileContributorEvent: {
      create: jest.fn().mockResolvedValue({ id: 'rpce-1' }),
    },
    sourceEdition: {
      findUnique: jest.fn().mockResolvedValue({ id: 'se-1', rightsProfileId: 'profile-1' }),
    },
    rightsComponent: {
      findUnique: jest.fn().mockResolvedValue({ id: 'rc-1', rightsProfileId: 'profile-1' }),
    },
    author: {
      findUnique: jest.fn().mockResolvedValue({ id: 'author-1' }),
      update: jest.fn().mockResolvedValue({ id: 'author-1', personId: 'person-1' }),
    },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(mockPrismaService)),
  };

  const mockRightsContentHashService = {
    checkStalenessForRightsProfile: jest.fn().mockResolvedValue([]),
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContributorsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PersonsService, useValue: mockPersonsService },
        { provide: RightsContentHashService, useValue: mockRightsContentHashService },
      ],
    }).compile();

    service = module.get<ContributorsService>(ContributorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should find all contributors delegating to PersonsService', async () => {
    const res = await service.findAll({});
    expect(res.items.length).toBe(1);
    expect(res.items[0].displayName).toBe('Homer');
  });

  it('should expose person fields the admin UI relies on', async () => {
    const res = await service.findOne('person-1');

    expect(res).toEqual(
      expect.objectContaining({
        id: 'person-1',
        displayName: 'Homer',
        nationalityCountry: 'GR',
        viafId: '224924963',
        wikidataId: 'Q6691',
        gutenbergAgentId: '705',
        publicDomainFromYear: 1900,
        notesRu: 'Легендарный автор.',
      }),
    );
  });

  it('should persist every mappable field on create', async () => {
    await service.create({
      displayName: 'Homer',
      birthYear: -800,
      deathYear: -750,
      nationalityCountry: 'GR',
      publicDomainFromYear: 1900,
      wikidataId: 'Q6691',
      viafId: '224924963',
      isni: '0000000121174572',
      gutenbergAgentId: '705',
      notesRu: 'Легендарный автор.',
    });

    expect(mockPersonsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalName: 'Homer',
        nationalityCountryCode: 'GR',
        publicDomainFromYear: 1900,
        wikidataId: 'Q6691',
        viafId: '224924963',
        isni: '0000000121174572',
        gutenbergAgentId: '705',
      }),
    );
  });

  it('should pass nationality through on update', async () => {
    await service.update('person-1', { nationalityCountry: 'GB' });

    expect(mockPersonsService.update).toHaveBeenCalledWith(
      'person-1',
      expect.objectContaining({ nationalityCountryCode: 'GB' }),
    );
  });

  it('should bridge a legacy author when authorId is provided', async () => {
    await service.create({ displayName: 'Homer', authorId: 'author-1' });

    expect(mockPrismaService.author.update).toHaveBeenCalledWith({
      where: { id: 'author-1' },
      data: { personId: 'person-1' },
    });
  });

  it('should link source edition contributor', async () => {
    const res = await service.linkSourceEdition(
      'se-1',
      { contributorId: 'person-1', role: ContributorRole.AUTHOR },
      'user-1',
    );

    expect(res).toBeDefined();
    expect(mockPrismaService.rightsProfileContributor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rightsProfileId: 'profile-1',
        personId: 'person-1',
        role: ContributorRole.AUTHOR,
        displayName: 'Homer',
      }),
    });
  });

  it('should link rights component contributor with any valid Prisma role', async () => {
    const res = await service.linkRightsComponent(
      'rc-1',
      { contributorId: 'person-1', role: ContributorRole.NARRATOR },
      'user-1',
    );

    expect(res).toBeDefined();
    expect(mockPrismaService.rightsProfileContributor.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        rightsComponentId: 'rc-1',
        role: ContributorRole.NARRATOR,
      }),
    });
  });

  it('should refuse to unlink a contributor that belongs to another rights component', async () => {
    mockPrismaService.rightsProfileContributor.findUnique.mockResolvedValueOnce({
      id: 'rpc-1',
      rightsProfileId: 'profile-1',
      rightsComponentId: 'other-component',
    });

    await expect(service.unlinkRightsComponent('rc-1', 'rpc-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrismaService.rightsProfileContributor.delete).not.toHaveBeenCalled();
  });

  it('should refuse to unlink a contributor that belongs to another rights profile', async () => {
    mockPrismaService.rightsProfileContributor.findUnique.mockResolvedValueOnce({
      id: 'rpc-1',
      rightsProfileId: 'other-profile',
      rightsComponentId: null,
    });

    await expect(service.unlinkSourceEdition('se-1', 'rpc-1', 'user-1')).rejects.toThrow(
      NotFoundException,
    );
    expect(mockPrismaService.rightsProfileContributor.delete).not.toHaveBeenCalled();
  });

  /**
   * WP-8.1 (R1-01): участник профиля прав входит в content hash, поэтому привязка и отвязка
   * обязаны проверить клиренс версий этого профиля — до WP-8 связь менялась молча.
   */
  describe('rights content hash', () => {
    it('checks the clearance of the profile when a contributor is linked', async () => {
      await service.linkSourceEdition(
        'se-1',
        { contributorId: 'person-1', role: ContributorRole.TRANSLATOR },
        'user-1',
      );

      expect(mockRightsContentHashService.checkStalenessForRightsProfile).toHaveBeenCalledWith(
        'profile-1',
        'PROFILE_CONTRIBUTOR_CHANGED',
        null,
        mockPrismaService,
      );
    });

    it('checks the clearance of the profile when a contributor is unlinked', async () => {
      await service.unlinkRightsComponent('rc-1', 'rpc-1', 'user-1');

      expect(mockRightsContentHashService.checkStalenessForRightsProfile).toHaveBeenCalledWith(
        'profile-1',
        'PROFILE_CONTRIBUTOR_CHANGED',
        null,
        mockPrismaService,
      );
    });
  });
});

/**
 * WP-10.1 (R8-02): связь `RightsProfileContributor` удаляется физически по решению WP-0.4,
 * поэтому отвязка обязана оставить неудаляемое событие — и записать его В ТОЙ ЖЕ транзакции,
 * что и само удаление. До правки отвязка не писала событий вообще: кто был отвязан от какого
 * компонента, восстановить было нечем.
 *
 * Двойник ниже — не мок проверяемого поведения, а имитация транзакции: запись, сделанная
 * через tx-клиент, попадает в БД только если коллбэк завершился успешно. Поэтому тест
 * «откат не оставляет события» проверяет атомарность, а не факт вызова.
 */
describe('ContributorsService — след отвязки участника (WP-10.1)', () => {
  interface Write {
    model: string;
    op: string;
    args: Record<string, unknown>;
  }

  const linkRow = {
    id: 'rpc-1',
    rightsProfileId: 'profile-1',
    rightsComponentId: 'rc-1',
    personId: 'person-1',
    role: ContributorRole.TRANSLATOR,
    displayName: 'Гнедич',
    creditedName: 'Н. И. Гнедич',
    canonicalName: 'Гнедич',
    birthYear: 1784,
    deathYear: 1833,
    notesRu: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  const createDouble = () => {
    const committed: Write[] = [];

    const clientFor = (buffer: Write[]) => ({
      rightsProfileContributor: {
        create: jest.fn((args: Record<string, unknown>) => {
          buffer.push({ model: 'rightsProfileContributor', op: 'create', args });
          return Promise.resolve({ id: 'rpc-1' });
        }),
        findUnique: jest.fn(() => Promise.resolve(linkRow)),
        delete: jest.fn((args: Record<string, unknown>) => {
          buffer.push({ model: 'rightsProfileContributor', op: 'delete', args });
          return Promise.resolve(linkRow);
        }),
      },
      rightsProfileContributorEvent: {
        create: jest.fn((args: Record<string, unknown>) => {
          buffer.push({ model: 'rightsProfileContributorEvent', op: 'create', args });
          return Promise.resolve({ id: 'evt-1' });
        }),
      },
      sourceEdition: {
        findUnique: jest.fn(() => Promise.resolve({ id: 'se-1', rightsProfileId: 'profile-1' })),
      },
      rightsComponent: {
        findUnique: jest.fn(() => Promise.resolve({ id: 'rc-1', rightsProfileId: 'profile-1' })),
      },
      author: { findUnique: jest.fn(), update: jest.fn() },
    });

    const base = clientFor(committed);

    return {
      committed,
      prisma: {
        ...base,
        $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> => {
          const pending: Write[] = [];
          const result = await callback(clientFor(pending));
          committed.push(...pending);
          return result;
        },
      },
    };
  };

  const eventsIn = (writes: Write[]): Array<Record<string, unknown>> =>
    writes
      .filter((write) => write.model === 'rightsProfileContributorEvent')
      .map((write) => write.args.data as Record<string, unknown>);

  const personForDouble = {
    id: 'person-1',
    canonicalName: 'Гнедич',
    birthYear: 1784,
    deathYear: 1833,
    nationalityCountryCode: 'RU',
    wikidataId: null,
    viafId: null,
    isni: null,
    gutenbergAgentId: null,
    publicDomainFromYear: 1904,
  };

  const build = (
    double: ReturnType<typeof createDouble>,
    hash: { checkStalenessForRightsProfile: jest.Mock },
  ) =>
    new ContributorsService(
      double.prisma as unknown as PrismaService,
      { findOne: jest.fn().mockResolvedValue(personForDouble) } as unknown as PersonsService,
      hash as unknown as RightsContentHashService,
    );

  const passingHash = () => ({ checkStalenessForRightsProfile: jest.fn().mockResolvedValue([]) });

  it('пишет событие UNLINKED с обеими сторонами связи, автором и временем', async () => {
    const double = createDouble();
    const service = build(double, passingHash());

    await service.unlinkRightsComponent('rc-1', 'rpc-1', 'user-42');

    const events = eventsIn(double.committed);
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        eventType: 'UNLINKED',
        rightsProfileId: 'profile-1',
        rightsProfileContributorId: 'rpc-1',
        rightsComponentId: 'rc-1',
        personId: 'person-1',
        role: ContributorRole.TRANSLATOR,
        displayName: 'Гнедич',
        createdByUserId: 'user-42',
      }),
    );
  });

  it('пишет событие UNLINKED и при отвязке от исходного издания', async () => {
    const double = createDouble();
    const service = build(double, passingHash());

    await service.unlinkSourceEdition('se-1', 'rpc-1', 'user-42');

    expect(eventsIn(double.committed)[0]).toEqual(
      expect.objectContaining({
        eventType: 'UNLINKED',
        rightsProfileContributorId: 'rpc-1',
        sourceEditionId: 'se-1',
        personId: 'person-1',
        createdByUserId: 'user-42',
      }),
    );
  });

  it('откат транзакции не оставляет ни удаления связи, ни события', async () => {
    const double = createDouble();
    const failingHash = {
      checkStalenessForRightsProfile: jest.fn().mockRejectedValue(new Error('DB gone')),
    };
    const service = build(double, failingHash);

    await expect(service.unlinkRightsComponent('rc-1', 'rpc-1', 'user-42')).rejects.toThrow(
      'DB gone',
    );

    expect(double.committed).toHaveLength(0);
  });

  it('привязка тоже оставляет след — событие LINKED в той же транзакции', async () => {
    const double = createDouble();
    const service = build(double, passingHash());

    await service.linkRightsComponent(
      'rc-1',
      { contributorId: 'person-1', role: ContributorRole.TRANSLATOR },
      'user-42',
    );

    expect(eventsIn(double.committed)[0]).toEqual(
      expect.objectContaining({
        eventType: 'LINKED',
        rightsProfileId: 'profile-1',
        rightsProfileContributorId: 'rpc-1',
        personId: 'person-1',
        role: ContributorRole.TRANSLATOR,
        createdByUserId: 'user-42',
      }),
    );
  });
});
