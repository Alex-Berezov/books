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
 * `LEGACY-385`. Тот же отказ закрытым списком: `Author.person` (`:624`) и
 * `RightsClaim.claimantPerson` (`:2547`) — тоже чужие связи, обе `SetNull`, и обе не считались
 * вовсе. Отказ собирает все найденные связи одним сообщением, а не первую попавшуюся.
 *
 * `LEGACY-386`. Проверка и удаление идут в одной транзакции с блокировкой строки персоны
 * (`SELECT ... FOR UPDATE`) первым оператором — иначе связь, созданная в окне между `count`
 * и `delete`, уезжает каскадом незамеченной.
 *
 * 🔴 Кейс с пустым клиентом — не формальность: именно он краснеет от возврата условия.
 * Клиент без делегатов связей повторяет ровно тот случай, ради которого условие и стояло,
 * и требует отказа, а не молчаливого удаления.
 */
describe('PersonsService.remove — проверка связей падает закрыто', () => {
  const person = { id: 'person-1', canonicalName: 'Иванов Иван', translations: [] };

  /**
   * 🔴 `tx` — **отдельный объект**, а не сам клиент пула, и это не украшение фикстуры.
   * В проде интерактивная транзакция Prisma живёт на выделенном соединении: `this.prisma`
   * внутри блока уходит по другому соединению, мимо замка, и не откатывается (`B09`,
   * `books/CLAUDE.md` §«Специфика проекта»). Мок, отдающий колбэку тот же объект, делает
   * `tx.author.count` и `this.prisma.author.count` неразличимыми — подмена осталась бы
   * зелёной, а окно `LEGACY-386` открылось бы заново. Поэтому делегаты клиента пула здесь
   * **бросают**: любое обращение к ним из тела транзакции красит тест по имени.
   *
   * Снаружи транзакции законен ровно один вызов — `findOne()` перед ней.
   *
   * ⚠️ Текст SQL сверяется отдельным кейсом ниже, и это тоже не формальность: имя таблицы
   * и `FOR UPDATE` внутри тега `$queryRaw` не проверяет ни `tsc`, ни `delegate-check`,
   * ни `drift-check`. Полностью закрыть это может только прогон против настоящей базы;
   * e2e на этот путь (`DELETE /admin/contributors/:id`) в репозитории нет ни до правки,
   * ни после. Записью не оформлено: пробел в покрытии порога заведения не проходит
   * (`tech-debt-autopilot.md`, «Порог заведения записи»).
   */
  function build(delegates: Record<string, unknown>) {
    const outOfTransaction = (name: string) =>
      jest.fn(() => {
        throw new Error(`${name} вызван на клиенте пула, а не на tx: правка ушла мимо замка`);
      });

    const tx: Record<string, unknown> = {
      person: { delete: jest.fn().mockResolvedValue(person) },
      $queryRaw: jest.fn().mockResolvedValue([]),
      ...delegates,
    };

    const client: Record<string, unknown> = {
      // `findOne()` идёт до транзакции и обязан ходить именно сюда.
      person: {
        findUnique: jest.fn().mockResolvedValue(person),
        delete: outOfTransaction('delete'),
      },
      $queryRaw: outOfTransaction('$queryRaw'),
      bookVersionContributor: { count: outOfTransaction('bookVersionContributor.count') },
      rightsProfileContributor: { count: outOfTransaction('rightsProfileContributor.count') },
      author: { count: outOfTransaction('author.count') },
      rightsClaim: { count: outOfTransaction('rightsClaim.count') },
    };
    client.$transaction = jest.fn().mockImplementation((fn: (tx: unknown) => unknown) => fn(tx));

    return {
      client,
      tx,
      service: new PersonsService(
        client as unknown as PrismaService,
        { checkStalenessForPerson: jest.fn() } as unknown as RightsContentHashService,
      ),
    };
  }

  function allLinksCount(overrides: Record<string, number> = {}) {
    const counts = {
      bookVersionContributor: 0,
      rightsProfileContributor: 0,
      author: 0,
      rightsClaim: 0,
      ...overrides,
    };
    return {
      bookVersionContributor: { count: jest.fn().mockResolvedValue(counts.bookVersionContributor) },
      rightsProfileContributor: {
        count: jest.fn().mockResolvedValue(counts.rightsProfileContributor),
      },
      author: { count: jest.fn().mockResolvedValue(counts.author) },
      rightsClaim: { count: jest.fn().mockResolvedValue(counts.rightsClaim) },
    };
  }

  it('отказывает 400 и не удаляет, когда персона связана с версией книги', async () => {
    const { tx, service } = build(allLinksCount({ bookVersionContributor: 2 }));

    await expect(service.remove('person-1')).rejects.toThrow(
      /still linked to 2 book version contributor records/,
    );
    expect((tx.person as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it('отказывает 400 и не удаляет, когда персона связана с правовым профилем', async () => {
    const { tx, service } = build(allLinksCount({ rightsProfileContributor: 3 }));

    await expect(service.remove('person-1')).rejects.toThrow(
      /still linked to 3 rights profile contributor records/,
    );
    expect((tx.person as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it('отказывает 400 и не удаляет, когда персона отмечена легаси-автором (LEGACY-385)', async () => {
    const { tx, service } = build(allLinksCount({ author: 1 }));

    await expect(service.remove('person-1')).rejects.toThrow(
      /still linked to 1 legacy author records/,
    );
    expect((tx.person as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it('отказывает 400 и не удаляет, когда персона — заявитель правовой претензии (LEGACY-385)', async () => {
    const { tx, service } = build(allLinksCount({ rightsClaim: 4 }));

    await expect(service.remove('person-1')).rejects.toThrow(
      /still linked to 4 rights claim records as claimant/,
    );
    expect((tx.person as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it('перечисляет все найденные связи одним отказом, а не только первую (LEGACY-385)', async () => {
    const { service } = build(
      allLinksCount({ bookVersionContributor: 2, author: 1, rightsClaim: 4 }),
    );

    await expect(service.remove('person-1')).rejects.toThrow(
      'Cannot delete Person: still linked to 2 book version contributor records, ' +
        '1 legacy author records, 4 rights claim records as claimant. ' +
        'Remove or reassign these links before deleting the person.',
    );
  });

  it('отказ не обещает ручки снятия, которой нет (решение арбитра 16.09.2026)', async () => {
    const { service } = build(allLinksCount({ author: 1 }));

    // 🔴 `Author.personId` в API не обнуляет никто: `contributors.service.ts:62` только
    // присваивает, поля нет в `UpdateAuthorDto`. Прежнее «Unlink them first» посылало
    // редактора искать ручку, которой не существует, — для этой связи и для закрытой
    // претензии. Возврат старой формулировки красит этот кейс.
    await expect(service.remove('person-1')).rejects.toThrow(
      /Remove or reassign these links before deleting the person\./,
    );
    await expect(service.remove('person-1')).rejects.not.toThrow(/Unlink them first/);
  });

  it('не удаляет персону, когда проверить связи нечем: делегатов в клиенте нет', async () => {
    const { tx, service } = build({});

    // 🔴 Отказ сверяется классом и текстом, а не голым `toThrow()`. Голая форма зеленела бы
    // на любом исключении — в том числе на `NotFoundException` из `findOne()`, если фикстура
    // `findUnique` однажды вернёт `null`: до проверки связей дело бы не дошло вовсе,
    // а сторож возврата `LEGACY-384` замолчал бы, оставшись зелёным.
    await expect(service.remove('person-1')).rejects.toThrow(TypeError);
    await expect(service.remove('person-1')).rejects.toThrow(/count/);
    expect((tx.person as { delete: jest.Mock }).delete).not.toHaveBeenCalled();
  });

  it('запирает строку персоны первым оператором транзакции (LEGACY-386)', async () => {
    const delegates = allLinksCount();
    const { client, tx, service } = build(delegates);

    await service.remove('person-1');

    expect(client.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);

    // 🔴 Порядок сверяется, а не только сам факт вызова. `toHaveBeenCalled()` осталось бы
    // зелёным и при замке, переставленном **после** четырёх `count`, — то есть при ровно
    // той гонке, ради закрытия которой заведена `LEGACY-386`: строка не заперта в момент,
    // когда по ней принимается решение.
    const lockOrder = (tx.$queryRaw as jest.Mock).mock.invocationCallOrder[0];
    for (const delegate of Object.values(delegates)) {
      const countOrder = delegate.count.mock.invocationCallOrder[0];
      expect(lockOrder).toBeLessThan(countOrder);
    }

    const deleteOrder = (tx.person as { delete: jest.Mock }).delete.mock.invocationCallOrder[0];
    expect(lockOrder).toBeLessThan(deleteOrder);
  });

  it('замок — это SELECT ... FOR UPDATE по строке персоны, а не просто запрос (LEGACY-386)', async () => {
    const { tx, service } = build(allLinksCount());

    await service.remove('person-1');

    // 🔴 Сверяется текст шаблона, а не только факт вызова. Образец — `tag-lock.service.spec.ts:87`.
    // Снятое `FOR UPDATE` превращает замок в обычное чтение: тест на порядок остаётся
    // зелёным (`$queryRaw` вызван первым), а гонка `LEGACY-386` возвращается целиком.
    // Пропавший `WHERE` запер бы всю таблицу персон вместо одной строки.
    const calls = (tx.$queryRaw as jest.Mock).mock.calls as Array<
      [{ raw?: readonly string[] }, ...unknown[]]
    >;
    expect(calls).toHaveLength(1);
    const template = (calls[0][0]?.raw ?? []).join(' ');

    expect(template).toContain('FOR UPDATE');
    expect(template).toContain('WHERE');
    expect(template).toContain('"Person"');
    // Идентификатор подставлен параметром шаблона, а не склейкой строки.
    expect(calls[0]).toHaveLength(2);
    expect(calls[0][1]).toBe('person-1');
  });

  it('считает связи по своему полю, а не по всей таблице (LEGACY-385)', async () => {
    const delegates = allLinksCount();
    const { service } = build(delegates);

    await service.remove('person-1');

    // 🔴 Сверяется `where`, а не только число вызовов. `count()` без фильтра компилируется
    // (аргумент необязателен) и в проде посчитал бы всю таблицу: удаление любой персоны
    // отказывало бы 400 навсегда, пока в `Author` или `RightsClaim` есть хоть одна строка.
    expect(delegates.bookVersionContributor.count).toHaveBeenCalledWith({
      where: { personId: 'person-1' },
    });
    expect(delegates.rightsProfileContributor.count).toHaveBeenCalledWith({
      where: { personId: 'person-1' },
    });
    expect(delegates.author.count).toHaveBeenCalledWith({ where: { personId: 'person-1' } });
    // Поле у претензии своё — `claimantPersonId`, а не `personId` (`prisma/schema.prisma:2546`).
    expect(delegates.rightsClaim.count).toHaveBeenCalledWith({
      where: { claimantPersonId: 'person-1' },
    });
  });

  it('удаляет персону без связей', async () => {
    const { tx, service } = build(allLinksCount());

    await expect(service.remove('person-1')).resolves.toEqual({ id: 'person-1' });
    const personTx = tx.person as { delete: jest.Mock };
    expect(personTx.delete).toHaveBeenCalledTimes(1);
    expect(personTx.delete).toHaveBeenCalledWith({ where: { id: 'person-1' } });
  });
});
