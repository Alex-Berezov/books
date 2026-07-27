import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { ContributorsService } from './contributors.service';
import { ContributorIdentityConfidenceDto, ContributorRoleDto } from './dto/create-contributor.dto';

describe('ContributorsService', () => {
  let service: ContributorsService;
  let prismaService: Record<string, unknown>;

  const mockContributor = {
    id: 'contributor-1',
    displayName: 'Homer',
    originalName: 'Ὅμηρος',
    birthYear: -800,
    deathYear: -750,
    nationalityCountry: 'GR',
    identityConfidence: 'CONFIRMED',
    sourceEditionContributors: [],
    rightsComponentContributors: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    prismaService = {
      contributor: {
        create: jest.fn().mockResolvedValue(mockContributor),
        findMany: jest.fn().mockResolvedValue([mockContributor]),
        count: jest.fn().mockResolvedValue(1),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'contributor-1') return Promise.resolve(mockContributor);
          return Promise.resolve(null);
        }),
        update: jest.fn().mockResolvedValue({ ...mockContributor, displayName: 'Homer Updated' }),
        delete: jest.fn().mockResolvedValue(mockContributor),
      },
      sourceEditionContributor: {
        create: jest.fn().mockResolvedValue({
          id: 'sec-1',
          sourceEditionId: 'se-1',
          contributorId: 'contributor-1',
          role: 'AUTHOR',
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'sec-1')
            return Promise.resolve({
              id: 'sec-1',
              sourceEditionId: 'se-1',
              contributorId: 'contributor-1',
            });
          return Promise.resolve(null);
        }),
        delete: jest.fn().mockResolvedValue({ id: 'sec-1' }),
      },
      rightsComponentContributor: {
        create: jest.fn().mockResolvedValue({
          id: 'rcc-1',
          rightsComponentId: 'rc-1',
          contributorId: 'contributor-1',
          role: 'TRANSLATOR',
        }),
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'rcc-1')
            return Promise.resolve({
              id: 'rcc-1',
              rightsComponentId: 'rc-1',
              contributorId: 'contributor-1',
            });
          return Promise.resolve(null);
        }),
        delete: jest.fn().mockResolvedValue({ id: 'rcc-1' }),
      },
      sourceEdition: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'se-1') return Promise.resolve({ id: 'se-1' });
          return Promise.resolve(null);
        }),
      },
      rightsComponent: {
        findUnique: jest.fn().mockImplementation(({ where }) => {
          if (where.id === 'rc-1') return Promise.resolve({ id: 'rc-1' });
          return Promise.resolve(null);
        }),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ContributorsService,
        {
          provide: PrismaService,
          useValue: prismaService,
        },
      ],
    }).compile();

    service = module.get<ContributorsService>(ContributorsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('create', () => {
    it('should create a contributor with valid payload', async () => {
      const result = await service.create({
        displayName: 'Homer',
        originalName: 'Ὅμηρος',
        birthYear: -800,
        deathYear: -750,
        nationalityCountry: 'GR',
        identityConfidence: ContributorIdentityConfidenceDto.CONFIRMED,
      });

      expect(result).toEqual(mockContributor);
    });
  });

  describe('findAll', () => {
    it('should return paginated contributors list', async () => {
      const result = await service.findAll({ page: 1, limit: 10, q: 'Homer' });

      expect(result.items).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.totalPages).toBe(1);
    });
  });

  describe('findOne', () => {
    it('should return a contributor by ID', async () => {
      const result = await service.findOne('contributor-1');
      expect(result).toEqual(mockContributor);
    });

    it('should throw NotFoundException if contributor does not exist', async () => {
      await expect(service.findOne('non-existent')).rejects.toThrow(NotFoundException);
    });
  });

  describe('update', () => {
    it('should update an existing contributor', async () => {
      const result = await service.update('contributor-1', { displayName: 'Homer Updated' });
      expect(result.displayName).toBe('Homer Updated');
    });
  });

  describe('remove', () => {
    it('should remove an existing contributor', async () => {
      const result = await service.remove('contributor-1');
      expect(result).toEqual(mockContributor);
    });
  });

  describe('linkSourceEdition', () => {
    it('should link contributor to source edition', async () => {
      const result = await service.linkSourceEdition('se-1', {
        contributorId: 'contributor-1',
        role: ContributorRoleDto.AUTHOR,
      });

      expect(result).toEqual({
        id: 'sec-1',
        sourceEditionId: 'se-1',
        contributorId: 'contributor-1',
        role: 'AUTHOR',
      });
    });

    it('should throw NotFoundException if source edition does not exist', async () => {
      await expect(
        service.linkSourceEdition('non-existent-se', {
          contributorId: 'contributor-1',
          role: ContributorRoleDto.AUTHOR,
        }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe('linkRightsComponent', () => {
    it('should link contributor to rights component', async () => {
      const result = await service.linkRightsComponent('rc-1', {
        contributorId: 'contributor-1',
        role: ContributorRoleDto.TRANSLATOR,
      });

      expect(result).toEqual({
        id: 'rcc-1',
        rightsComponentId: 'rc-1',
        contributorId: 'contributor-1',
        role: 'TRANSLATOR',
      });
    });
  });
});
