import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonsService } from '../persons/persons.service';
import { CreateContributorDto } from './dto/create-contributor.dto';
import { LinkRightsComponentContributorDto } from './dto/link-rights-component-contributor.dto';
import { LinkSourceEditionContributorDto } from './dto/link-source-edition-contributor.dto';
import { QueryContributorsDto } from './dto/query-contributors.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';
import type { ContributorResponseDto } from './dto/contributor-response.dto';
import type { PersonRecord } from '../persons/person-interface';

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

  private get authorModel() {
    return (this.prisma as unknown as Record<string, unknown>)['author'] as {
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private toContributorResponse(person: PersonRecord): ContributorResponseDto {
    return {
      id: person.id,
      displayName: person.canonicalName,
      sortName: person.sortName,
      birthDate: person.birthDate,
      deathDate: person.deathDate,
      birthYear: person.birthYear,
      deathYear: person.deathYear,
      nationalityCountry: person.nationalityCountryCode,
      publicDomainFromYear: person.publicDomainFromYear,
      wikidataId: person.wikidataId,
      viafId: person.viafId,
      isni: person.isni,
      gutenbergAgentId: person.gutenbergAgentId,
      notesRu: person.notesRu,
      createdAt: person.createdAt,
      updatedAt: person.updatedAt,
    };
  }

  private async bridgeLegacyAuthor(authorId: string, personId: string) {
    const author = await this.authorModel.findUnique({ where: { id: authorId } });
    if (!author) {
      throw new NotFoundException(`Author with ID "${authorId}" not found`);
    }

    await this.authorModel.update({ where: { id: authorId }, data: { personId } });
  }

  async create(dto: CreateContributorDto): Promise<ContributorResponseDto> {
    const person = (await this.personsService.create({
      canonicalName: dto.displayName,
      birthDate: dto.birthDate,
      deathDate: dto.deathDate,
      birthYear: dto.birthYear,
      deathYear: dto.deathYear,
      nationalityCountryCode: dto.nationalityCountry,
      publicDomainFromYear: dto.publicDomainFromYear,
      wikidataId: dto.wikidataId,
      viafId: dto.viafId,
      isni: dto.isni,
      gutenbergAgentId: dto.gutenbergAgentId,
      notesRu: dto.notesRu,
    })) as unknown as PersonRecord;

    if (dto.authorId) {
      await this.bridgeLegacyAuthor(dto.authorId, person.id);
    }

    return this.toContributorResponse(person);
  }

  async findAll(query: QueryContributorsDto) {
    const limit = query.limit ?? 20;
    const page = query.page ?? 1;

    const res = await this.personsService.findAll({
      q: query.q,
      role: query.role,
      limit,
      offset: (page - 1) * limit,
    });

    return {
      items: (res.items as unknown as PersonRecord[]).map((person) =>
        this.toContributorResponse(person),
      ),
      total: res.total,
      page,
      limit,
    };
  }

  async findOne(id: string): Promise<ContributorResponseDto> {
    const person = (await this.personsService.findOne(id)) as unknown as PersonRecord;
    return this.toContributorResponse(person);
  }

  async update(id: string, dto: UpdateContributorDto): Promise<ContributorResponseDto> {
    const person = (await this.personsService.update(id, {
      ...(dto.displayName !== undefined ? { canonicalName: dto.displayName } : {}),
      ...(dto.birthDate !== undefined ? { birthDate: dto.birthDate } : {}),
      ...(dto.deathDate !== undefined ? { deathDate: dto.deathDate } : {}),
      ...(dto.birthYear !== undefined ? { birthYear: dto.birthYear } : {}),
      ...(dto.deathYear !== undefined ? { deathYear: dto.deathYear } : {}),
      ...(dto.nationalityCountry !== undefined
        ? { nationalityCountryCode: dto.nationalityCountry }
        : {}),
      ...(dto.publicDomainFromYear !== undefined
        ? { publicDomainFromYear: dto.publicDomainFromYear }
        : {}),
      ...(dto.wikidataId !== undefined ? { wikidataId: dto.wikidataId } : {}),
      ...(dto.viafId !== undefined ? { viafId: dto.viafId } : {}),
      ...(dto.isni !== undefined ? { isni: dto.isni } : {}),
      ...(dto.gutenbergAgentId !== undefined ? { gutenbergAgentId: dto.gutenbergAgentId } : {}),
      ...(dto.notesRu !== undefined ? { notesRu: dto.notesRu } : {}),
    })) as unknown as PersonRecord;

    if (dto.authorId) {
      await this.bridgeLegacyAuthor(dto.authorId, person.id);
    }

    return this.toContributorResponse(person);
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

    const person = (await this.personsService.findOne(
      dto.contributorId,
    )) as unknown as PersonRecord;

    return this.rpcModel.create({
      data: {
        rightsProfileId: sourceEdition['rightsProfileId'],
        personId: person.id,
        role: dto.role,
        displayName: person.canonicalName,
        canonicalName: person.canonicalName,
        creditedName: dto.creditedName ?? person.canonicalName,
        birthYear: person.birthYear,
        deathYear: person.deathYear,
        nationalityCountryCode: person.nationalityCountryCode,
        wikidataId: person.wikidataId,
        viafId: person.viafId,
        isni: person.isni,
        gutenbergAgentId: person.gutenbergAgentId,
        publicDomainFromYear: person.publicDomainFromYear,
        notesRu: dto.notesRu ?? null,
      },
    });
  }

  async unlinkSourceEdition(sourceEditionId: string, linkId: string) {
    const sourceEdition = await this.sourceEditionModel.findUnique({
      where: { id: sourceEditionId },
    });
    if (!sourceEdition) {
      throw new NotFoundException(`SourceEdition with ID "${sourceEditionId}" not found`);
    }

    const link = await this.rpcModel.findUnique({ where: { id: linkId } });
    if (!link || link['rightsProfileId'] !== sourceEdition['rightsProfileId']) {
      throw new NotFoundException(
        `Contributor link with ID "${linkId}" not found for source edition "${sourceEditionId}"`,
      );
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

    const person = (await this.personsService.findOne(
      dto.contributorId,
    )) as unknown as PersonRecord;

    return this.rpcModel.create({
      data: {
        rightsProfileId: component['rightsProfileId'],
        rightsComponentId,
        personId: person.id,
        role: dto.role,
        displayName: person.canonicalName,
        canonicalName: person.canonicalName,
        creditedName: dto.creditedName ?? person.canonicalName,
        birthYear: person.birthYear,
        deathYear: person.deathYear,
        nationalityCountryCode: person.nationalityCountryCode,
        wikidataId: person.wikidataId,
        viafId: person.viafId,
        isni: person.isni,
        gutenbergAgentId: person.gutenbergAgentId,
        publicDomainFromYear: person.publicDomainFromYear,
        notesRu: dto.notesRu ?? null,
      },
    });
  }

  async unlinkRightsComponent(rightsComponentId: string, linkId: string) {
    const component = await this.rightsComponentModel.findUnique({
      where: { id: rightsComponentId },
    });
    if (!component) {
      throw new NotFoundException(`RightsComponent with ID "${rightsComponentId}" not found`);
    }

    const link = await this.rpcModel.findUnique({ where: { id: linkId } });
    if (!link || link['rightsComponentId'] !== rightsComponentId) {
      throw new NotFoundException(
        `Contributor link with ID "${linkId}" not found for rights component "${rightsComponentId}"`,
      );
    }

    return this.rpcModel.delete({ where: { id: linkId } });
  }
}
