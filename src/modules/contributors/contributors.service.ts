import { Injectable, NotFoundException } from '@nestjs/common';
import { PersonsService } from '../persons/persons.service';
import { RightsContentHashService } from '../rights-intake/rights-content-hash.service';
import { PrismaService } from '../../prisma/prisma.service';
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
    private readonly rightsContentHashService: RightsContentHashService,
  ) {}

  private rpcModelOf(client: unknown) {
    return (client as Record<string, unknown>)['rightsProfileContributor'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      findUnique: (args: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
      delete: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
    };
  }

  private get rpcModel() {
    return this.rpcModelOf(this.prisma);
  }

  private rpcEventModelOf(client: unknown) {
    return (client as Record<string, unknown>)['rightsProfileContributorEvent'] as {
      create: (args: Record<string, unknown>) => Promise<Record<string, unknown>>;
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

  async linkSourceEdition(
    sourceEditionId: string,
    dto: LinkSourceEditionContributorDto,
    userId: string,
  ) {
    const sourceEdition = await this.sourceEditionModel.findUnique({
      where: { id: sourceEditionId },
    });
    if (!sourceEdition) {
      throw new NotFoundException(`SourceEdition with ID "${sourceEditionId}" not found`);
    }

    const person = (await this.personsService.findOne(
      dto.contributorId,
    )) as unknown as PersonRecord;

    const rightsProfileId = sourceEdition['rightsProfileId'] as string;
    const data: Record<string, unknown> = {
      rightsProfileId,
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
    };

    return this.withProfileStaleness(rightsProfileId, async (tx) => {
      const created = await this.rpcModelOf(tx).create({ data });
      await this.recordContributorEvent(
        tx,
        'LINKED',
        { ...data, id: created['id'] },
        { rightsProfileId, sourceEditionId, userId },
      );
      return created;
    });
  }

  async unlinkSourceEdition(sourceEditionId: string, linkId: string, userId: string) {
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

    const rightsProfileId = sourceEdition['rightsProfileId'] as string;

    return this.withProfileStaleness(rightsProfileId, async (tx) => {
      const removed = await this.rpcModelOf(tx).delete({ where: { id: linkId } });
      await this.recordContributorEvent(tx, 'UNLINKED', link, {
        rightsProfileId,
        sourceEditionId,
        userId,
      });
      return removed;
    });
  }

  async linkRightsComponent(
    rightsComponentId: string,
    dto: LinkRightsComponentContributorDto,
    userId: string,
  ) {
    const component = await this.rightsComponentModel.findUnique({
      where: { id: rightsComponentId },
    });
    if (!component) {
      throw new NotFoundException(`RightsComponent with ID "${rightsComponentId}" not found`);
    }

    const person = (await this.personsService.findOne(
      dto.contributorId,
    )) as unknown as PersonRecord;

    const rightsProfileId = component['rightsProfileId'] as string;
    const data: Record<string, unknown> = {
      rightsProfileId,
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
    };

    return this.withProfileStaleness(rightsProfileId, async (tx) => {
      const created = await this.rpcModelOf(tx).create({ data });
      await this.recordContributorEvent(
        tx,
        'LINKED',
        { ...data, id: created['id'] },
        { rightsProfileId, rightsComponentId, userId },
      );
      return created;
    });
  }

  async unlinkRightsComponent(rightsComponentId: string, linkId: string, userId: string) {
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

    const rightsProfileId = component['rightsProfileId'] as string;

    return this.withProfileStaleness(rightsProfileId, async (tx) => {
      const removed = await this.rpcModelOf(tx).delete({ where: { id: linkId } });
      await this.recordContributorEvent(tx, 'UNLINKED', link, {
        rightsProfileId,
        rightsComponentId,
        userId,
      });
      return removed;
    });
  }

  /**
   * WP-10.1 (R8-02): связь `RightsProfileContributor` удаляется физически — решение WP-0.4
   * оставило физическое удаление связей и потребовало взамен неудаляемое событие в той же
   * транзакции. Событие пишется через переданный tx-клиент: при откате транзакции не остаётся
   * ни удаления, ни следа о нём, а при успехе — и то и другое.
   *
   * Снимок связи кладётся в событие целиком: строка к моменту чтения журнала уже удалена,
   * и восстановить, кого именно отвязали от какого компонента, будет больше неоткуда.
   */
  private async recordContributorEvent(
    tx: unknown,
    eventType: 'LINKED' | 'UNLINKED',
    link: Record<string, unknown>,
    context: {
      rightsProfileId: string;
      rightsComponentId?: string | null;
      sourceEditionId?: string | null;
      userId: string;
    },
  ): Promise<void> {
    const linkedAt = link['createdAt'];

    await this.rpcEventModelOf(tx).create({
      data: {
        rightsProfileId: context.rightsProfileId,
        rightsProfileContributorId: link['id'],
        rightsComponentId: context.rightsComponentId ?? link['rightsComponentId'] ?? null,
        sourceEditionId: context.sourceEditionId ?? null,
        personId: link['personId'] ?? null,
        eventType,
        role: link['role'] ?? null,
        displayName: link['displayName'] ?? null,
        creditedName: link['creditedName'] ?? null,
        payload: {
          canonicalName: link['canonicalName'] ?? null,
          birthYear: link['birthYear'] ?? null,
          deathYear: link['deathYear'] ?? null,
          nationalityCountryCode: link['nationalityCountryCode'] ?? null,
          notesRu: link['notesRu'] ?? null,
          linkedAt: linkedAt instanceof Date ? linkedAt.toISOString() : null,
        },
        createdByUserId: context.userId,
      },
    });
  }

  /**
   * WP-8.1 (R1-01): участники профиля прав входят в content hash — переводчик определяет
   * правовое основание перевода. Привязка и отвязка проверяют клиренс каждой версии профиля
   * в той же транзакции, что и сама связь.
   */
  private async withProfileStaleness<T>(
    rightsProfileId: string | null,
    work: (tx: unknown) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(
      async (tx) => {
        const result = await work(tx);

        if (rightsProfileId) {
          await this.rightsContentHashService.checkStalenessForRightsProfile(
            rightsProfileId,
            'PROFILE_CONTRIBUTOR_CHANGED',
            null,
            tx,
          );
        }

        return result;
      },
      // Пересчёт по всем версиям профиля читает главы целиком — дефолтных 5 секунд мало.
      { timeout: 30_000, maxWait: 10_000 },
    );
  }
}
