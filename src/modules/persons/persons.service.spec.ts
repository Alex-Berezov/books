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

/**
 * `LEGACY-177`. Ручка принимает смещение (`QueryPersonsDto.offset`), а единая обёртка
 * ответа несёт номер страницы. Входной контракт менять нельзя, поэтому перевод
 * `offset -> page` живёт в сервисе — и здесь он посажен: сместившаяся на единицу
 * страница в ответе неотличима от исправной ни по типам, ни по `tsc`.
 */
describe('PersonsService.findAll — обёртка ответа', () => {
  let db: { person: { findMany: jest.Mock; count: jest.Mock } };
  let service: PersonsService;

  beforeEach(() => {
    db = {
      person: {
        findMany: jest.fn().mockResolvedValue([{ id: 'p1' }]),
        count: jest.fn().mockResolvedValue(42),
      },
    };
    service = new PersonsService(
      db as unknown as PrismaService,
      {
        checkStalenessForPerson: jest.fn(),
      } as unknown as RightsContentHashService,
    );
  });

  it('переводит offset в номер страницы и отдаёт {items, pagination}', async () => {
    const res = await service.findAll({ limit: 20, offset: 40 });

    expect(db.person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 40 }),
    );
    expect(res).toEqual({
      items: [{ id: 'p1' }],
      pagination: { page: 3, limit: 20, total: 42, totalPages: 3 },
    });
  });

  it('заданный page выигрывает у offset', async () => {
    const res = await service.findAll({ limit: 20, offset: 40, page: 2 });

    // Именно `skip: 20`, а не 40: при обоих параметрах окно задаёт `page`
    // (решение арбитра 13.09.2026), 400 в этом случае не отдаётся.
    expect(db.person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 20 }),
    );
    expect(res.pagination.page).toBe(2);
  });

  it('неполное смещение выравнивается до границы страницы — и в теле, и в выборке', async () => {
    const res = await service.findAll({ limit: 20, offset: 25 });

    // 🔴 Проверяется и `skip`, а не только номер страницы. До 13.09.2026 тело
    // сообщало `page: 2`, а выбирались строки 25-44, тогда как вторая страница
    // размера 20 — это строки 20-39: клиент, идущий по `pagination.page`,
    // терял пять строк. Возврат `skip: offset` роняет эту спеку.
    expect(db.person.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ take: 20, skip: 20 }),
    );
    expect(res.pagination.page).toBe(2);
  });

  it('search отдаёт первую страницу той же обёрткой', async () => {
    const res = await service.search('Twain');

    expect(res.pagination).toEqual({ page: 1, limit: 20, total: 42, totalPages: 3 });
  });
});

/**
 * `LEGACY-384`. Проверка связей перед удалением персоны стояла под условием
 * `if (model && typeof model.count === 'function')` поверх `Record<string, unknown>`:
 * делегат не нашёлся — проверка **пропускалась**, а не отказывала, и персона удалялась.
 * У `BookVersionContributor.person` в схеме стоит `onDelete: Cascade`
 * (`prisma/schema.prisma:1915`), поэтому вместо 400 «unlink them first» строка привязки
 * к версии книги снималась целиком, а участники входят в content hash правового клиренса.
 * У `RightsProfileContributor.person` стоит `onDelete: SetNull` (`:1950`): там строка
 * остаётся, но теряет привязку к персоне.
 *
 * 🔴 Кейс с пустым клиентом — не формальность: именно он краснеет от возврата условия.
 * Клиент без `bookVersionContributor`/`rightsProfileContributor` повторяет ровно тот
 * случай, ради которого условие и стояло, и требует отказа, а не молчаливого удаления.
 */
describe('PersonsService.remove — проверка связей падает закрыто', () => {
  const person = { id: 'person-1', canonicalName: 'Иванов Иван', translations: [] };

  function build(client: Record<string, unknown>) {
    return new PersonsService(
      client as unknown as PrismaService,
      { checkStalenessForPerson: jest.fn() } as unknown as RightsContentHashService,
    );
  }

  function personDelegate() {
    return {
      findUnique: jest.fn().mockResolvedValue(person),
      delete: jest.fn().mockResolvedValue(person),
    };
  }

  it('отказывает 400 и не удаляет, когда персона связана с версией книги', async () => {
    const client = {
      person: personDelegate(),
      bookVersionContributor: { count: jest.fn().mockResolvedValue(2) },
      rightsProfileContributor: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = build(client);

    await expect(service.remove('person-1')).rejects.toThrow(
      /linked to 2 book version contributor records/,
    );
    expect(client.person.delete).not.toHaveBeenCalled();
  });

  it('отказывает 400 и не удаляет, когда персона связана с правовым профилем', async () => {
    const client = {
      person: personDelegate(),
      bookVersionContributor: { count: jest.fn().mockResolvedValue(0) },
      rightsProfileContributor: { count: jest.fn().mockResolvedValue(3) },
    };
    const service = build(client);

    await expect(service.remove('person-1')).rejects.toThrow(
      /linked to 3 rights profile contributor records/,
    );
    expect(client.person.delete).not.toHaveBeenCalled();
  });

  it('не удаляет персону, когда проверить связи нечем: делегатов в клиенте нет', async () => {
    const client = { person: personDelegate() };
    const service = build(client);

    // 🔴 Отказ сверяется классом и текстом, а не голым `toThrow()`. Голая форма зеленела бы
    // на любом исключении — в том числе на `NotFoundException` из `findOne()`, если фикстура
    // `findUnique` однажды вернёт `null`: до проверки связей дело бы не дошло вовсе,
    // а сторож возврата `LEGACY-384` замолчал бы, оставшись зелёным.
    await expect(service.remove('person-1')).rejects.toThrow(TypeError);
    await expect(service.remove('person-1')).rejects.toThrow(/count/);
    expect(client.person.delete).not.toHaveBeenCalled();
  });

  it('удаляет персону без связей', async () => {
    const client = {
      person: personDelegate(),
      bookVersionContributor: { count: jest.fn().mockResolvedValue(0) },
      rightsProfileContributor: { count: jest.fn().mockResolvedValue(0) },
    };
    const service = build(client);

    await expect(service.remove('person-1')).resolves.toEqual({ id: 'person-1' });
    expect(client.person.delete).toHaveBeenCalledTimes(1);
    expect(client.person.delete).toHaveBeenCalledWith({ where: { id: 'person-1' } });
  });
});
