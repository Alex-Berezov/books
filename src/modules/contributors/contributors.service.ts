import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonsService } from '../persons/persons.service';
import { CreateContributorDto } from './dto/create-contributor.dto';
import { LinkRightsComponentContributorDto } from './dto/link-rights-component-contributor.dto';
import { LinkSourceEditionContributorDto } from './dto/link-source-edition-contributor.dto';
import { QueryContributorsDto } from './dto/query-contributors.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';
import type { ContributorRole } from '../persons/person-interface';

@Injectable()
export class ContributorsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly personsService: PersonsService,
  ) {}

  private get rpcModel() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsProfileContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get sourceEditionModel() {
    return (this.prisma as unknown as Record<string, unknown>)['sourceEdition'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  private get rightsComponentModel() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsComponent'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
    };
  }

  async create(dto: CreateContributorDto) {
    const person = await this.personsService.create({
      canonicalName: dto.displayName,
      birthYear: dto.birthYear ?? undefined,
      deathYear: dto.deathYear ?? undefined,
      nationalityCountryCode: dto.nationalityCountry ?? undefined,
      viafId: dto.viafId ?? undefined,
      notesRu: dto.notesRu ?? undefined,
    });

    return {
      id: person.id,
      displayName: person.canonicalName,
      birthYear: person.birthYear,
      deathYear: person.deathYear,
      viafId: person.viafId,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  async findAll(query: QueryContributorsDto) {
    const res = await this.personsService.findAll({
      q: query.q,
      role: query.role as ContributorRole | undefined,
      limit: query.limit,
      offset: query.page && query.limit ? (query.page - 1) * query.limit : undefined,
    });

    return {
      items: res.items.map((person) => ({
        id: person.id,
        displayName: person.canonicalName,
        birthYear: person.birthYear,
        deathYear: person.deathYear,
        viafId: person.viafId,
        createdAt: person.createdAt,
        updatedAt: person.updatedAt,
      })),
      total: res.total,
      page: query.page ?? 1,
      limit: query.limit ?? 20,
    };
  }

  async findOne(id: string) {
    const person = await this.personsService.findOne(id);
    return {
      id: person.id,
      displayName: person.canonicalName,
      birthYear: person.birthYear,
      deathYear: person.deathYear,
      viafId: person.viafId,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  async update(id: string, dto: UpdateContributorDto) {
    const person = await this.personsService.update(id, {
      canonicalName: dto.displayName,
      birthYear: dto.birthYear,
      deathYear: dto.deathYear,
      viafId: dto.viafId,
      notesRu: dto.notesRu,
    });

    return {
      id: person.id,
      displayName: person.canonicalName,
      birthYear: person.birthYear,
      deathYear: person.deathYear,
      viafId: person.viafId,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  async remove(id: string): Promise<{ id: string }> {
    return await this.personsService.remove(id);
  }

  async linkSourceEdition(sourceEditionId: string, dto: LinkSourceEditionContributorDto) {
    const sourceEdition = await this.sourceEditionModel.findUnique({
      where: { id: sourceEditionId },
    });
    if (!sourceEdition) {
      throw new NotFoundException(`SourceEdition with ID "${sourceEditionId}" not found`);
    }

    const person = await this.personsService.findOne(dto.contributorId);

    const created = await this.rpcModel.create({
      data: {
        rightsProfileId: sourceEdition['rightsProfileId'],
        personId: person.id,
        role: dto.role,
        displayName: person.canonicalName,
        creditedName: dto.creditedName ?? person.canonicalName,
        notesRu: dto.notesRu ?? null,
      },
    });

    return created;
  }

  async unlinkSourceEdition(_sourceEditionId: string, linkId: string) {
    const link = await this.rpcModel.findUnique({ where: { id: linkId } });
    if (!link) {
      throw new NotFoundException(`RightsProfileContributor link with ID "${linkId}" not found`);
    }
    return this.rpcModel.delete({ where: { id: linkId } });
  }

  async linkRightsComponent(rightsComponentId: string, dto: LinkRightsComponentContributorDto) {
    const component = await this.rightsComponentModel.findUnique({
      where: { id: rightsComponentId },
    });
    if (!component) {
      throw new NotFoundException(`RightsComponent with ID "${rightsComponentId}" not found`);
    }

    const person = await this.personsService.findOne(dto.contributorId);

    const created = await this.rpcModel.create({
      data: {
        rightsProfileId: component['rightsProfileId'],
        rightsComponentId,
        personId: person.id,
        role: dto.role,
        displayName: person.canonicalName,
        creditedName: dto.creditedName ?? person.canonicalName,
        notesRu: dto.notesRu ?? null,
      },
    });

    return created;
  }

  async unlinkRightsComponent(_rightsComponentId: string, linkId: string) {
    const link = await this.rpcModel.findUnique({ where: { id: linkId } });
    if (!link) {
      throw new NotFoundException(`RightsProfileContributor link with ID "${linkId}" not found`);
    }
    return this.rpcModel.delete({ where: { id: linkId } });
  }
}
