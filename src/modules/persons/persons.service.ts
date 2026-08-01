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

@Injectable()
export class PersonsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly rightsContentHashService: RightsContentHashService,
  ) {}

  private personModelOf(client: Prisma.TransactionClient | PrismaService) {
    return (client as unknown as Record<string, unknown>)['person'] as {
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get personModel() {
    return (this.prisma as unknown as Record<string, unknown>)['person'] as {
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      count: (args: Record<string, unknown>) => Promise<number>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  public async findAll(query: QueryPersonsDto) {
    const { q, role, type, language, limit = 20, offset = 0 } = query;

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
        skip: offset,
        orderBy: { canonicalName: 'asc' },
        include: {
          translations: true,
        },
      }),
      this.personModel.count({ where }),
    ]);

    return {
      items,
      total,
      limit,
      offset,
    };
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

    const bvcModel = (this.prisma as unknown as Record<string, unknown>)[
      'bookVersionContributor'
    ] as { count?: (args: Record<string, unknown>) => Promise<number> } | undefined;

    if (bvcModel && typeof bvcModel.count === 'function') {
      const bvcCount = await bvcModel.count({ where: { personId: id } });
      if (bvcCount > 0) {
        throw new BadRequestException(
          `Cannot delete Person: linked to ${bvcCount} book version contributor records. Unlink them first.`,
        );
      }
    }

    const rpcModel = (this.prisma as unknown as Record<string, unknown>)[
      'rightsProfileContributor'
    ] as { count?: (args: Record<string, unknown>) => Promise<number> } | undefined;

    if (rpcModel && typeof rpcModel.count === 'function') {
      const rpcCount = await rpcModel.count({ where: { personId: id } });
      if (rpcCount > 0) {
        throw new BadRequestException(
          `Cannot delete Person: linked to ${rpcCount} rights profile contributor records. Unlink them first.`,
        );
      }
    }

    await this.personModel.delete({ where: { id } });
    return { id };
  }
}
