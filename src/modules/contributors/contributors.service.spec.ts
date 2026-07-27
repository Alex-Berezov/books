import { Test, TestingModule } from '@nestjs/testing';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonsService } from '../persons/persons.service';
import { ContributorsService } from './contributors.service';

describe('ContributorsService', () => {
  let service: ContributorsService;

  const mockPerson = {
    id: 'person-1',
    canonicalName: 'Homer',
    birthYear: -800,
    deathYear: -750,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const mockPersonsService = {
    create: jest.fn().mockResolvedValue(mockPerson),
    findAll: jest.fn().mockResolvedValue({ items: [mockPerson], total: 1 }),
    findOne: jest.fn().mockResolvedValue(mockPerson),
    update: jest.fn().mockResolvedValue(mockPerson),
    remove: jest.fn().mockResolvedValue(mockPerson),
  };

  const mockPrismaService = {
    rightsProfileContributor: {
      create: jest.fn().mockResolvedValue({ id: 'rpc-1' }),
      findUnique: jest.fn().mockResolvedValue({ id: 'rpc-1' }),
      delete: jest.fn().mockResolvedValue({ id: 'rpc-1' }),
    },
    sourceEdition: {
      findUnique: jest.fn().mockResolvedValue({ id: 'se-1', rightsProfileId: 'profile-1' }),
    },
    rightsComponent: {
      findUnique: jest.fn().mockResolvedValue({ id: 'rc-1', rightsProfileId: 'profile-1' }),
    },
  };

  beforeEach(async () => {
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

  it('should link source edition contributor', async () => {
    const res = await service.linkSourceEdition('se-1', {
      contributorId: 'person-1',
      role: 'AUTHOR' as any,
    });
    expect(res).toBeDefined();
  });

  it('should link rights component contributor', async () => {
    const res = await service.linkRightsComponent('rc-1', {
      contributorId: 'person-1',
      role: 'AUTHOR' as any,
    });
    expect(res).toBeDefined();
  });
});
