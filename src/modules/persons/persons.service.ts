import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  RIGHTS_RELEVANT_PERSON_FIELDS,
  RightsContentHashService,
} from '../rights-intake/rights-content-hash.service';
import { PrismaService } from '../../prisma/prisma.service';
import { CreatePersonDto } from './dto/create-person.dto';
import { QueryPersonsDto } from './dto/query-persons.dto';
import { UpdatePersonDto } from './dto/update-person.dto';
import type { Prisma } from '@prisma/client';
import { paginated } from '../../shared/dto/paginated-response.dto';

@Injectable()
export class PersonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
  ) {}

  /**
   * Делегат берётся у сгенерированного клиента напрямую. До 14.09.2026 здесь стояли ручные
   * интерфейсы поверх `Record<string, unknown>` — тот же приём, что снят в модуле претензий
   * (`LEGACY-344`). Цена была не в стиле: `Record<string, unknown>` непрозрачен для сторожа
   * схемы ответа, и три маршрута персон (`GET`, `POST`, `PATCH /admin/persons*`) висели
   * в вердикте `unverifiable` — схему ответа им сверять было не с чем
   * (`scripts/check-response-schema.mjs`, `LEGACY-016`).
   *
   * ⚠️ Снят приём здесь **не весь**: соседний `person-resolver.service.ts` держит его
   * до сих пор — это место числится за ведущей записью класса `LEGACY-345` и правится
   * целиком своим коммитом, без изменения поведения. В `remove()` приём снят 14.09.2026
   * вместе с открытым отказом (`LEGACY-384`).
   */
  private personModelOf(client: Prisma.TransactionClient | PrismaService) {
    return client.person;
  }

  private get personModel() {
    return this.prisma.person;
  }

  public async findAll(query: QueryPersonsDto) {
    const { q, role, type, language, limit = 20, offset = 0, page: requestedPage } = query;

    // Окно выдачи считается один раз и в одном месте (решение арбитра 13.09.2026).
    // `page` приоритетнее `offset`; заданный в одиночку `offset` выравнивается
    // вниз до границы страницы, иначе тело ответа сообщало бы `page`, под
    // которым лежит другое окно строк: при `?offset=15&limit=10` вернулись бы
    // строки 15-24, а `page: 2` по контракту обёртки означает 10-19, и клиент,
    // идущий по `pagination.page`, терял бы пять строк.
    const page = requestedPage ?? (limit > 0 ? Math.floor(offset / limit) + 1 : 1);
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (type) {
      where['type'] = type;
    }

    if (role) {
      where['OR'] = [
        { bookVersionContributors: { some: { role } } },
        { rightsProfileContributors: { some: { role } } },
      ];
    }

    if (q?.trim()) {
      const searchTerm = q.trim();
      const qFilter: Array<Record<string, unknown>> = [
        { canonicalName: { contains: searchTerm, mode: 'insensitive' } },
        { sortName: { contains: searchTerm, mode: 'insensitive' } },
        { wikidataId: { equals: searchTerm, mode: 'insensitive' } },
        { viafId: { equals: searchTerm, mode: 'insensitive' } },
        { isni: { equals: searchTerm, mode: 'insensitive' } },
        { gutenbergAgentId: { equals: searchTerm, mode: 'insensitive' } },
        {
          translations: {
            some: {
              displayName: { contains: searchTerm, mode: 'insensitive' },
              ...(language ? { language } : {}),
            },
          },
        },
      ];

      if (where['OR']) {
        where['AND'] = [{ OR: where['OR'] }, { OR: qFilter }];
        delete where['OR'];
      } else {
        where['OR'] = qFilter;
      }
    } else if (language) {
      where['translations'] = {
        some: { language },
      };
    }

    const [items, total] = await Promise.all([
      this.personModel.findMany({
        where,
        take: limit,
        skip,
        orderBy: { canonicalName: 'asc' },
        include: {
          translations: true,
        },
      }),
      this.personModel.count({ where }),
    ]);

    // `offset` остаётся во ВХОДЕ ручки (`QueryPersonsDto.offset`) — менять то,
    // что шлёт клиент, задача `LEGACY-177` не разрешает. Наружу идёт единая
    // обёртка, и `page` в ней точно описывает отданное окно.
    return paginated(items, { page, limit, total });
  }

  public async findOne(id: string) {
    const person = await this.personModel.findUnique({
      where: { id },
      include: {
        translations: true,
      },
    });

    if (!person) {
      throw new NotFoundException(`Person with ID "${id}" not found`);
    }

    return person;
  }

  public async create(dto: CreatePersonDto) {
    return this.personModel.create({
      data: {
        type: dto.type,
        canonicalName: dto.canonicalName,
        sortName: dto.sortName || null,
        slug: dto.slug || null,
        birthDate: dto.birthDate || null,
        deathDate: dto.deathDate || null,
        birthYear: dto.birthYear || null,
        deathYear: dto.deathYear || null,
        nationalityCountryCode: dto.nationalityCountryCode || null,
        publicDomainFromYear: dto.publicDomainFromYear || null,
        wikidataId: dto.wikidataId?.trim() || null,
        viafId: dto.viafId?.trim() || null,
        isni: dto.isni?.trim() || null,
        gutenbergAgentId: dto.gutenbergAgentId?.trim() || null,
        notesRu: dto.notesRu || null,
      },
      include: {
        translations: true,
      },
    });
  }

  public async update(id: string, dto: UpdatePersonDto) {
    const before = (await this.findOne(id)) as unknown as Record<string, unknown>;

    const data: Record<string, unknown> = {
      ...(dto.type !== undefined ? { type: dto.type } : {}),
      ...(dto.canonicalName !== undefined ? { canonicalName: dto.canonicalName } : {}),
      ...(dto.sortName !== undefined ? { sortName: dto.sortName || null } : {}),
      ...(dto.slug !== undefined ? { slug: dto.slug || null } : {}),
      ...(dto.birthDate !== undefined ? { birthDate: dto.birthDate || null } : {}),
      ...(dto.deathDate !== undefined ? { deathDate: dto.deathDate || null } : {}),
      ...(dto.birthYear !== undefined ? { birthYear: dto.birthYear || null } : {}),
      ...(dto.deathYear !== undefined ? { deathYear: dto.deathYear || null } : {}),
      ...(dto.nationalityCountryCode !== undefined
        ? { nationalityCountryCode: dto.nationalityCountryCode || null }
        : {}),
      ...(dto.publicDomainFromYear !== undefined
        ? { publicDomainFromYear: dto.publicDomainFromYear || null }
        : {}),
      ...(dto.wikidataId !== undefined ? { wikidataId: dto.wikidataId?.trim() || null } : {}),
      ...(dto.viafId !== undefined ? { viafId: dto.viafId?.trim() || null } : {}),
      ...(dto.isni !== undefined ? { isni: dto.isni?.trim() || null } : {}),
      ...(dto.gutenbergAgentId !== undefined
        ? { gutenbergAgentId: dto.gutenbergAgentId?.trim() || null }
        : {}),
      ...(dto.notesRu !== undefined ? { notesRu: dto.notesRu || null } : {}),
    };

    /**
     * WP-8.1 (R1-01): год смерти и год перехода в public domain определяют правовое основание
     * перевода, а участники входят в content hash. Значит, правка персоны должна доходить до
     * клиренса каждой версии, где участник учтён, — и в той же транзакции, что сама правка.
     * Проверка сужена до правовых полей: правка заметки или имени в карточке клиренс не трогает.
     */
    const touchesRights = RIGHTS_RELEVANT_PERSON_FIELDS.some(
      (field) => field in data && data[field] !== before[field],
    );

    return this.prisma.$transaction(
      async (tx) => {
        const updated = await this.personModelOf(tx).update({
          where: { id },
          data,
          include: {
            translations: true,
          },
        });

        if (touchesRights) {
          await this.rightsContentHashService.checkStalenessForPerson(
            id,
            'CONTRIBUTOR_PERSON_CHANGED',
            null,
            tx,
          );
        }

        return updated;
      },
      /**
       * Пересчёт идёт по всем версиям участника, а хеш версии читает главы целиком, поэтому
       * дефолтных 5 секунд Prisma на транзакцию не хватает уже на десятке версий. Предел
       * всё равно есть: у автора с очень большим каталогом правка упрётся в таймаут и
       * откатится целиком. Это безопасный отказ — клиренс остаётся прежним, а гейт
       * пересчитывает живой хеш при каждой попытке публикации (ADR-010).
       */
      { timeout: 30_000, maxWait: 10_000 },
    );
  }

  public async search(q: string) {
    return this.findAll({ q, limit: 20 });
  }

  public async remove(id: string): Promise<{ id: string }> {
    await this.findOne(id);

    // Проверка связей идёт по сгенерированному делегату и **безусловно** (`LEGACY-384`).
    // До 14.09.2026 оба обращения шли через `Record<string, unknown>` под условием
    // `if (model && typeof model.count === 'function')`, то есть при ненайденном делегате
    // проверка не отказывала, а пропускалась, и персона удалялась. Теряются при этом
    // **чужие** связи, и двумя разными способами: `BookVersionContributor.person` стоит под
    // `onDelete: Cascade` (`prisma/schema.prisma:1915`) — строка привязки к версии книги
    // исчезает целиком; `RightsProfileContributor.person` стоит под `onDelete: SetNull`
    // (`:1950`) — строка остаётся с `personId = NULL` и осиротевшим `displayName`.
    // `PersonTranslation.person` тоже каскадный (`:1884`), но это собственные переводы имени
    // персоны — они и должны уходить вместе с ней, поэтому здесь не считаются.
    // Условия вокруг проверки быть не должно: нечем проверить целостность — падать,
    // а не удалять.
    const versionContributorLinks = await this.prisma.bookVersionContributor.count({
      where: { personId: id },
    });
    if (versionContributorLinks > 0) {
      throw new BadRequestException(
        `Cannot delete Person: linked to ${versionContributorLinks} book version contributor records. Unlink them first.`,
      );
    }

    const rightsProfileLinks = await this.prisma.rightsProfileContributor.count({
      where: { personId: id },
    });
    if (rightsProfileLinks > 0) {
      throw new BadRequestException(
        `Cannot delete Person: linked to ${rightsProfileLinks} rights profile contributor records. Unlink them first.`,
      );
    }

    await this.personModel.delete({ where: { id } });
    return { id };
  }
}
