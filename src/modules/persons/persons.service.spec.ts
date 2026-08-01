import { PersonsService } from './persons.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';

/**
 * WP-8.1 (R1-01). Год смерти переводчика решает, находится ли перевод в public domain,
 * поэтому правка персоны обязана доходить до клиренса каждой версии, где участник учтён.
 * До WP-8 модуль персон о правах не знал вообще.
 */
describe('PersonsService — content hash triggers', () => {
  const person = {
    id: 'person-1',
    canonicalName: 'Иванов Иван',
    birthYear: 1870,
    deathYear: 1940,
    publicDomainFromYear: 2011,
    nationalityCountryCode: 'RU',
    notesRu: null,
  };

  let prisma: {
    person: {
      findUnique: jest.Mock;
      update: jest.Mock;
    };
    $transaction: jest.Mock;
  };
  let hashService: { checkStalenessForPerson: jest.Mock };
  let service: PersonsService;

  beforeEach(() => {
    prisma = {
      person: {
        findUnique: jest.fn().mockResolvedValue(person),
        update: jest.fn().mockImplementation((args: { data: Record<string, unknown> }) => ({
          ...person,
          ...args.data,
        })),
      },
      $transaction: jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma)),
    };
    hashService = { checkStalenessForPerson: jest.fn().mockResolvedValue([]) };

    service = new PersonsService(
      prisma as unknown as PrismaService,
      hashService as unknown as RightsContentHashService,
    );
  });

  it('marks the clearance of every affected version when the death year changes', async () => {
    await service.update('person-1', { deathYear: 1990 });

    expect(hashService.checkStalenessForPerson).toHaveBeenCalledWith(
      'person-1',
      'CONTRIBUTOR_PERSON_CHANGED',
      null,
      prisma,
    );
  });

  it('marks the clearance when the public domain year changes', async () => {
    await service.update('person-1', { publicDomainFromYear: 2061 });

    expect(hashService.checkStalenessForPerson).toHaveBeenCalled();
  });

  it('does not touch the clearance when only editorial fields change', async () => {
    await service.update('person-1', { notesRu: 'уточнил источник даты' });

    expect(hashService.checkStalenessForPerson).not.toHaveBeenCalled();
  });

  it('does not touch the clearance when the value is submitted unchanged', async () => {
    await service.update('person-1', { deathYear: 1940 });

    expect(hashService.checkStalenessForPerson).not.toHaveBeenCalled();
  });
});
