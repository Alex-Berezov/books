export enum ContributorRole {
  AUTHOR = 'AUTHOR',
  TRANSLATOR = 'TRANSLATOR',
  EDITOR = 'EDITOR',
  ILLUSTRATOR = 'ILLUSTRATOR',
  NARRATOR = 'NARRATOR',
  ADAPTER = 'ADAPTER',
  COMPILER = 'COMPILER',
  COMMENTATOR = 'COMMENTATOR',
  INTRODUCTION_AUTHOR = 'INTRODUCTION_AUTHOR',
  AFTERWORD_AUTHOR = 'AFTERWORD_AUTHOR',
  COVER_ARTIST = 'COVER_ARTIST',
  RIGHTS_HOLDER = 'RIGHTS_HOLDER',
  OTHER = 'OTHER',
}

export enum PersonType {
  NATURAL_PERSON = 'NATURAL_PERSON',
  ORGANIZATION = 'ORGANIZATION',
  UNKNOWN = 'UNKNOWN',
}

export interface PersonRecord {
  id: string;
  type: PersonType;
  canonicalName: string;
  sortName: string | null;
  slug: string | null;
  birthDate: string | null;
  deathDate: string | null;
  birthYear: number | null;
  deathYear: number | null;
  nationalityCountryCode: string | null;
  publicDomainFromYear: number | null;
  wikidataId: string | null;
  viafId: string | null;
  isni: string | null;
  gutenbergAgentId: string | null;
  notesRu: string | null;
  createdAt: Date;
  updatedAt: Date;
  translations?: unknown[];
}
