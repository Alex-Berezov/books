import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { PersonRecord, PersonType } from './person-interface';

/**
 * `LEGACY-347`: имя не найдено в отчёте — это форма отчёта, а не отказ базы.
 * Вызывающий обязан ловить именно этот класс и не трогать больше ничего:
 * отказ драйвера обязан всплыть наружу как есть.
 */
export class PersonIdentityMissingError extends Error {}

type PersonDatabaseClient = PrismaService | Prisma.TransactionClient;

export interface ContributorInput {
  displayName: string;
  canonicalName?: string | null;
  type?: PersonType | null;
  birthDate?: string | null;
  deathDate?: string | null;
  birthYear?: number | null;
  deathYear?: number | null;
  nationalityCountryCode?: string | null;
  publicDomainFromYear?: number | null;
  wikidataId?: string | null;
  viafId?: string | null;
  isni?: string | null;
  gutenbergAgentId?: string | null;
  notesRu?: string | null;
}

@Injectable()
export class PersonResolverService {
  private readonly logger = new Logger(PersonResolverService.name);

  constructor(private readonly prisma: PrismaService) {}

  private personModel(client: PersonDatabaseClient) {
    return (client as unknown as Record<string, unknown>)['person'] as {
      findFirst: (args: Record<string, unknown>) => Promise<PersonRecord | null>;
      findMany: (args: Record<string, unknown>) => Promise<PersonRecord[]>;
      create: (args: Record<string, unknown>) => Promise<PersonRecord>;
      update: (args: Record<string, unknown>) => Promise<PersonRecord>;
    };
  }

  /**
   * `tx` — клиент чужой транзакции (`LEGACY-347`). Не передан — идёт по своему
   * `this.prisma`, как раньше; передан — обязан использоваться целиком, второе
   * соединение из того же пула здесь не открывается.
   */
  public async resolveOrCreatePerson(
    input: ContributorInput,
    tx?: Prisma.TransactionClient,
  ): Promise<PersonRecord> {
    const client = tx ?? this.prisma;
    const canonicalName = (input.canonicalName || input.displayName || '').trim();
    if (!canonicalName) {
      throw new PersonIdentityMissingError(
        'Canonical or display name is required for person resolution',
      );
    }

    // 1. Search by wikidataId
    if (input.wikidataId?.trim()) {
      const person = await this.personModel(client).findFirst({
        where: { wikidataId: input.wikidataId.trim() },
      });
      if (person) {
        return this.updateSafeEmptyFields(person, input, client);
      }
    }

    // 2. Search by viafId
    if (input.viafId?.trim()) {
      const person = await this.personModel(client).findFirst({
        where: { viafId: input.viafId.trim() },
      });
      if (person) {
        return this.updateSafeEmptyFields(person, input, client);
      }
    }

    // 3. Search by isni
    if (input.isni?.trim()) {
      const person = await this.personModel(client).findFirst({
        where: { isni: input.isni.trim() },
      });
      if (person) {
        return this.updateSafeEmptyFields(person, input, client);
      }
    }

    // 4. Search by gutenbergAgentId
    if (input.gutenbergAgentId?.trim()) {
      const person = await this.personModel(client).findFirst({
        where: { gutenbergAgentId: input.gutenbergAgentId.trim() },
      });
      if (person) {
        return this.updateSafeEmptyFields(person, input, client);
      }
    }

    // 5. Search by normalized name + birth/death year
    const normalizedName = canonicalName.toLowerCase();
    const candidates =
      (await this.personModel(client).findMany({
        where: {
          canonicalName: {
            equals: canonicalName,
            mode: 'insensitive',
          },
        },
      })) || [];

    const matchedPerson = candidates.find((cand) => {
      const candName = cand.canonicalName.trim().toLowerCase();
      if (candName !== normalizedName) return false;

      if (input.birthYear && cand.birthYear && input.birthYear !== cand.birthYear) {
        return false;
      }
      if (input.deathYear && cand.deathYear && input.deathYear !== cand.deathYear) {
        return false;
      }
      return true;
    });

    if (matchedPerson) {
      return this.updateSafeEmptyFields(matchedPerson, input, client);
    }

    // 6. If no match found, create new Person
    return this.personModel(client).create({
      data: {
        type: input.type || 'NATURAL_PERSON',
        canonicalName,
        birthDate: input.birthDate || null,
        deathDate: input.deathDate || null,
        birthYear: input.birthYear || null,
        deathYear: input.deathYear || null,
        nationalityCountryCode: input.nationalityCountryCode || null,
        publicDomainFromYear: input.publicDomainFromYear || null,
        wikidataId: input.wikidataId?.trim() || null,
        viafId: input.viafId?.trim() || null,
        isni: input.isni?.trim() || null,
        gutenbergAgentId: input.gutenbergAgentId?.trim() || null,
        notesRu: input.notesRu || null,
      },
    });
  }

  private async updateSafeEmptyFields(
    person: PersonRecord,
    input: ContributorInput,
    client: PersonDatabaseClient,
  ): Promise<PersonRecord> {
    const dataToUpdate: Record<string, unknown> = {};

    if (!person.birthDate && input.birthDate) dataToUpdate['birthDate'] = input.birthDate;
    if (!person.deathDate && input.deathDate) dataToUpdate['deathDate'] = input.deathDate;
    if (!person.birthYear && input.birthYear) dataToUpdate['birthYear'] = input.birthYear;
    if (!person.deathYear && input.deathYear) dataToUpdate['deathYear'] = input.deathYear;
    if (!person.nationalityCountryCode && input.nationalityCountryCode) {
      dataToUpdate['nationalityCountryCode'] = input.nationalityCountryCode;
    }
    if (!person.publicDomainFromYear && input.publicDomainFromYear) {
      dataToUpdate['publicDomainFromYear'] = input.publicDomainFromYear;
    }
    if (!person.wikidataId && input.wikidataId?.trim())
      dataToUpdate['wikidataId'] = input.wikidataId.trim();
    if (!person.viafId && input.viafId?.trim()) dataToUpdate['viafId'] = input.viafId.trim();
    if (!person.isni && input.isni?.trim()) dataToUpdate['isni'] = input.isni.trim();
    if (!person.gutenbergAgentId && input.gutenbergAgentId?.trim()) {
      dataToUpdate['gutenbergAgentId'] = input.gutenbergAgentId.trim();
    }
    if (!person.notesRu && input.notesRu) dataToUpdate['notesRu'] = input.notesRu;

    if (Object.keys(dataToUpdate).length === 0) {
      return person;
    }

    const updated = await this.personModel(client).update({
      where: { id: person.id },
      data: dataToUpdate,
    });
    return updated || ({ ...person, ...dataToUpdate } as PersonRecord);
  }
}
