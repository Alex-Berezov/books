import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { ContributorRole } from '../persons/person-interface';
import { PersonsService } from '../persons/persons.service';
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
  };

  beforeEach(async () => {
    jest.clearAllMocks();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContributorsService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: PersonsService, useValue: mockPersonsService },
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
    const res = await service.linkSourceEdition('se-1', {
      contributorId: 'person-1',
      role: ContributorRole.AUTHOR,
    });

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
    const res = await service.linkRightsComponent('rc-1', {
      contributorId: 'person-1',
      role: ContributorRole.NARRATOR,
    });

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

    await expect(service.unlinkRightsComponent('rc-1', 'rpc-1')).rejects.toThrow(NotFoundException);
    expect(mockPrismaService.rightsProfileContributor.delete).not.toHaveBeenCalled();
  });

  it('should refuse to unlink a contributor that belongs to another rights profile', async () => {
    mockPrismaService.rightsProfileContributor.findUnique.mockResolvedValueOnce({
      id: 'rpc-1',
      rightsProfileId: 'other-profile',
      rightsComponentId: null,
    });

    await expect(service.unlinkSourceEdition('se-1', 'rpc-1')).rejects.toThrow(NotFoundException);
    expect(mockPrismaService.rightsProfileContributor.delete).not.toHaveBeenCalled();
  });
});
