import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CreateContributorDto } from './dto/create-contributor.dto';
import { LinkRightsComponentContributorDto } from './dto/link-rights-component-contributor.dto';
import { LinkSourceEditionContributorDto } from './dto/link-source-edition-contributor.dto';
import { QueryContributorsDto } from './dto/query-contributors.dto';
import { UpdateContributorDto } from './dto/update-contributor.dto';

@Injectable()
export class ContributorsService {
  constructor(private readonly prisma: PrismaService) {}

  private get contributorModel() {
    return (this.prisma as unknown as Record<string, unknown>)['contributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findMany: (args: Record<string, unknown>) => Promise<Array<Record<string, unknown>>>;
      count: (args: Record<string, unknown>) => Promise<number>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      update: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get sourceEditionContributorModel() {
    return (this.prisma as unknown as Record<string, unknown>)['sourceEditionContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get rightsComponentContributorModel() {
    return (this.prisma as unknown as Record<string, unknown>)['rightsComponentContributor'] as {
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
    const data: Record<string, unknown> = {
      displayName: dto.displayName,
      originalName: dto.originalName ?? null,
      birthDate: dto.birthDate ? new Date(dto.birthDate) : null,
      deathDate: dto.deathDate ? new Date(dto.deathDate) : null,
      birthYear: dto.birthYear ?? null,
      deathYear: dto.deathYear ?? null,
      nationalityCountry: dto.nationalityCountry ?? null,
      pseudonym: dto.pseudonym ?? null,
      viafId: dto.viafId ?? null,
      locAuthorityId: dto.locAuthorityId ?? null,
      otherAuthorityIds: dto.otherAuthorityIds ?? null,
      identityConfidence: dto.identityConfidence ?? 'CONFIRMED',
      notesRu: dto.notesRu ?? null,
      authorId: dto.authorId ?? null,
    };

    return this.contributorModel.create({ data });
  }

  async findAll(query: QueryContributorsDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};

    if (query.q) {
      where['OR'] = [
        { displayName: { contains: query.q, mode: 'insensitive' } },
        { originalName: { contains: query.q, mode: 'insensitive' } },
        { pseudonym: { contains: query.q, mode: 'insensitive' } },
      ];
    }

    if (query.identityConfidence) {
      where['identityConfidence'] = query.identityConfidence;
    }

    if (query.role) {
      where['OR'] = [
        { sourceEditionContributors: { some: { role: query.role } } },
        { rightsComponentContributors: { some: { role: query.role } } },
      ];
    }

    const [items, total] = await Promise.all([
      this.contributorModel.findMany({
        where,
        skip,
        take: limit,
        orderBy: { displayName: 'asc' },
        include: {
          sourceEditionContributors: true,
          rightsComponentContributors: true,
        },
      }),
      this.contributorModel.count({ where }),
    ]);

    const totalPages = Math.ceil(total / limit);

    return {
      items,
      total,
      page,
      limit,
      totalPages,
    };
  }

  async findOne(id: string) {
    const contributor = await this.contributorModel.findUnique({
      where: { id },
      include: {
        sourceEditionContributors: {
          include: {
            sourceEdition: true,
          },
        },
        rightsComponentContributors: {
          include: {
            rightsComponent: true,
          },
        },
      },
    });

    if (!contributor) {
      throw new NotFoundException(`Contributor with ID '${id}' not found`);
    }

    return contributor;
  }

  async update(id: string, dto: UpdateContributorDto) {
    await this.findOne(id);

    const data: Record<string, unknown> = {};

    if (dto.displayName !== undefined) data['displayName'] = dto.displayName;
    if (dto.originalName !== undefined) data['originalName'] = dto.originalName ?? null;
    if (dto.birthDate !== undefined)
      data['birthDate'] = dto.birthDate ? new Date(dto.birthDate) : null;
    if (dto.deathDate !== undefined)
      data['deathDate'] = dto.deathDate ? new Date(dto.deathDate) : null;
    if (dto.birthYear !== undefined) data['birthYear'] = dto.birthYear ?? null;
    if (dto.deathYear !== undefined) data['deathYear'] = dto.deathYear ?? null;
    if (dto.nationalityCountry !== undefined)
      data['nationalityCountry'] = dto.nationalityCountry ?? null;
    if (dto.pseudonym !== undefined) data['pseudonym'] = dto.pseudonym ?? null;
    if (dto.viafId !== undefined) data['viafId'] = dto.viafId ?? null;
    if (dto.locAuthorityId !== undefined) data['locAuthorityId'] = dto.locAuthorityId ?? null;
    if (dto.otherAuthorityIds !== undefined)
      data['otherAuthorityIds'] = dto.otherAuthorityIds ?? null;
    if (dto.identityConfidence !== undefined) data['identityConfidence'] = dto.identityConfidence;
    if (dto.notesRu !== undefined) data['notesRu'] = dto.notesRu ?? null;
    if (dto.authorId !== undefined) data['authorId'] = dto.authorId ?? null;

    return this.contributorModel.update({
      where: { id },
      data,
    });
  }

  async remove(id: string) {
    await this.findOne(id);
    return this.contributorModel.delete({ where: { id } });
  }

  async linkSourceEdition(sourceEditionId: string, dto: LinkSourceEditionContributorDto) {
    const sourceEdition = await this.sourceEditionModel.findUnique({
      where: { id: sourceEditionId },
    });
    if (!sourceEdition) {
      throw new NotFoundException(`SourceEdition with ID '${sourceEditionId}' not found`);
    }

    await this.findOne(dto.contributorId);

    return this.sourceEditionContributorModel.create({
      data: {
        sourceEditionId,
        contributorId: dto.contributorId,
        role: dto.role,
        creditedName: dto.creditedName ?? null,
        evidenceId: dto.evidenceId ?? null,
        notesRu: dto.notesRu ?? null,
      },
    });
  }

  async unlinkSourceEdition(sourceEditionId: string, linkId: string) {
    const link = await this.sourceEditionContributorModel.findUnique({
      where: { id: linkId },
    });
    if (!link || link['sourceEditionId'] !== sourceEditionId) {
      throw new NotFoundException(
        `SourceEditionContributor link '${linkId}' for SourceEdition '${sourceEditionId}' not found`,
      );
    }

    return this.sourceEditionContributorModel.delete({ where: { id: linkId } });
  }

  async linkRightsComponent(rightsComponentId: string, dto: LinkRightsComponentContributorDto) {
    const component = await this.rightsComponentModel.findUnique({
      where: { id: rightsComponentId },
    });
    if (!component) {
      throw new NotFoundException(`RightsComponent with ID '${rightsComponentId}' not found`);
    }

    await this.findOne(dto.contributorId);

    return this.rightsComponentContributorModel.create({
      data: {
        rightsComponentId,
        contributorId: dto.contributorId,
        role: dto.role,
        creditedName: dto.creditedName ?? null,
        notesRu: dto.notesRu ?? null,
      },
    });
  }

  async unlinkRightsComponent(rightsComponentId: string, linkId: string) {
    const link = await this.rightsComponentContributorModel.findUnique({
      where: { id: linkId },
    });
    if (!link || link['rightsComponentId'] !== rightsComponentId) {
      throw new NotFoundException(
        `RightsComponentContributor link '${linkId}' for RightsComponent '${rightsComponentId}' not found`,
      );
    }

    return this.rightsComponentContributorModel.delete({ where: { id: linkId } });
  }
}
