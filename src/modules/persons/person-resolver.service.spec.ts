import { Test, TestingModule } from '@nestjs/testing';
import { PersonIdentityMissingError, PersonResolverService } from './person-resolver.service';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonType } from './person-interface';

describe('PersonResolverService', () => {
  let service: PersonResolverService;
  let prismaMock: {
    person: {
      findFirst: jest.Mock;
      findMany: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
    };
  };

  beforeEach(async () => {
    prismaMock = {
      person: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [PersonResolverService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();

    service = module.get<PersonResolverService>(PersonResolverService);
  });

  it('should find existing person by wikidataId and update safe empty fields', async () => {
    const existingPerson = {
      id: 'p1',
      canonicalName: 'Mark Twain',
      type: PersonType.NATURAL_PERSON,
      wikidataId: 'Q7245',
      viafId: null,
      birthYear: 1835,
      deathYear: 1910,
    };
    prismaMock.person.findFirst.mockResolvedValueOnce(existingPerson);
    prismaMock.person.update.mockImplementation(({ data }) =>
      Promise.resolve({ ...existingPerson, ...data }),
    );

    const result = await service.resolveOrCreatePerson({
      displayName: 'Mark Twain',
      wikidataId: 'Q7245',
      viafId: '505050',
    });

    expect(prismaMock.person.findFirst).toHaveBeenCalledWith({
      where: { wikidataId: 'Q7245' },
    });
    expect(prismaMock.person.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { viafId: '505050' },
    });
    expect(result.viafId).toBe('505050');
  });

  it('should find existing person by viafId', async () => {
    const existingPerson = {
      id: 'p2',
      canonicalName: 'Leo Tolstoy',
      type: PersonType.NATURAL_PERSON,
      viafId: '96085',
    };
    prismaMock.person.findFirst.mockResolvedValueOnce(existingPerson); // viaf

    const result = await service.resolveOrCreatePerson({
      displayName: 'Leo Tolstoy',
      viafId: '96085',
    });

    expect(result.id).toBe('p2');
  });

  it('should find existing person by normalized name + birth/death year match', async () => {
    const existingPerson = {
      id: 'p3',
      canonicalName: 'Victor Hugo',
      birthYear: 1802,
      deathYear: 1885,
    };
    prismaMock.person.findMany.mockResolvedValueOnce([existingPerson]);

    const result = await service.resolveOrCreatePerson({
      displayName: 'victor hugo',
      birthYear: 1802,
      deathYear: 1885,
    });

    expect(result.id).toBe('p3');
  });

  it('should create a new person if no match is found', async () => {
    prismaMock.person.findMany.mockResolvedValueOnce([]);
    const createdPerson = {
      id: 'p4',
      canonicalName: 'New Author',
      type: PersonType.NATURAL_PERSON,
    };
    prismaMock.person.create.mockResolvedValueOnce(createdPerson);

    const result = await service.resolveOrCreatePerson({
      displayName: 'New Author',
    });

    expect(prismaMock.person.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        canonicalName: 'New Author',
        type: PersonType.NATURAL_PERSON,
      }),
    });
    expect(result.id).toBe('p4');
  });

  it('should not overwrite non-empty fields during update', async () => {
    const existingPerson = {
      id: 'p5',
      canonicalName: 'Existing Person',
      viafId: 'ORIGINAL_VIAF',
      birthYear: 1900,
    };
    prismaMock.person.findFirst.mockResolvedValueOnce(existingPerson);

    const result = await service.resolveOrCreatePerson({
      displayName: 'Existing Person',
      wikidataId: 'Q999',
      viafId: 'NEW_VIAF_ATTEMPT', // Should be ignored since original exists
    });

    expect(prismaMock.person.update).toHaveBeenCalledWith({
      where: { id: 'p5' },
      data: { wikidataId: 'Q999' },
    });
    expect(result.viafId).toBe('ORIGINAL_VIAF');
  });

  /**
   * `LEGACY-347`: имя отсутствует — это форма отчёта
   * (`PersonIdentityMissingError`), а не отказ базы; вызывающий обязан ловить
   * именно этот класс.
   */
  it('throws PersonIdentityMissingError when neither canonicalName nor displayName is usable', async () => {
    await expect(service.resolveOrCreatePerson({ displayName: '   ' })).rejects.toBeInstanceOf(
      PersonIdentityMissingError,
    );
    expect(prismaMock.person.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.person.findMany).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-347`: `tx` передан — обязан использоваться целиком, второе
   * соединение из `this.prisma` здесь открываться не должно.
   */
  it('reads and writes through the passed tx client instead of this.prisma', async () => {
    const txMock = {
      person: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValueOnce([]),
        create: jest.fn().mockResolvedValueOnce({ id: 'p-tx', canonicalName: 'Tx Author' }),
        update: jest.fn(),
      },
    };

    const result = await service.resolveOrCreatePerson(
      { displayName: 'Tx Author' },
      txMock as never,
    );

    expect(result.id).toBe('p-tx');
    expect(txMock.person.findMany).toHaveBeenCalled();
    expect(txMock.person.create).toHaveBeenCalled();
    expect(prismaMock.person.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.person.findMany).not.toHaveBeenCalled();
    expect(prismaMock.person.create).not.toHaveBeenCalled();
  });

  /**
   * `LEGACY-347` (ревью): предыдущий тест на `tx` проходит только ветку
   * «совпадений нет → create». Ветка «человек уже найден → updateSafeEmptyFields»
   * гоняет отдельный делегат `client.person.update` — если один из пяти
   * вызовов `updateSafeEmptyFields` в `resolveOrCreatePerson` тихо заменят
   * на `this.prisma`, эта ветка останется непроверенной без отдельного кейса.
   */
  it('reads and updates an existing person through the passed tx client, not this.prisma', async () => {
    const existingPerson = {
      id: 'p-tx-existing',
      canonicalName: 'Tx Existing',
      viafId: '12345',
    };
    const txMock = {
      person: {
        findFirst: jest.fn().mockResolvedValueOnce(existingPerson),
        findMany: jest.fn(),
        create: jest.fn(),
        update: jest
          .fn()
          .mockImplementation(({ data }) => Promise.resolve({ ...existingPerson, ...data })),
      },
    };

    const result = await service.resolveOrCreatePerson(
      { displayName: 'Tx Existing', viafId: '12345', birthYear: 1900 },
      txMock as never,
    );

    expect(txMock.person.findFirst).toHaveBeenCalledWith({ where: { viafId: '12345' } });
    expect(txMock.person.update).toHaveBeenCalledWith({
      where: { id: 'p-tx-existing' },
      data: { birthYear: 1900 },
    });
    expect(result.birthYear).toBe(1900);
    expect(prismaMock.person.findFirst).not.toHaveBeenCalled();
    expect(prismaMock.person.update).not.toHaveBeenCalled();
  });
});
