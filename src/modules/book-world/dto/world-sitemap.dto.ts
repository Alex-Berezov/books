import { ApiProperty } from '@nestjs/swagger';
import { WorldAlternateDto } from './book-world-response.dto';

export class WorldSitemapEntityDto {
  @ApiProperty({ type: String })
  key!: string;

  @ApiProperty({ type: String, format: 'date-time', description: 'updatedAt of the entity' })
  lastmod!: Date;

  @ApiProperty({
    type: [WorldAlternateDto],
    description:
      'Languages where the entity with this key is public and indexable on a published version ' +
      'without editorial noindex; the version itself included',
  })
  alternates!: WorldAlternateDto[];
}

/** Элемент карты мира — опубликованная версия со своими индексируемыми сущностями. */
export class WorldSitemapItemDto {
  @ApiProperty({ type: String, description: 'Version slug' })
  slug!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Latest updatedAt of the public entities of the version (the /wiki page)',
  })
  lastmod!: Date;

  @ApiProperty({
    type: [WorldAlternateDto],
    description:
      'Languages where the /wiki page exists on a published version without editorial noindex; ' +
      'the version itself included',
  })
  alternates!: WorldAlternateDto[];

  @ApiProperty({
    type: [WorldSitemapEntityDto],
    description: 'Public entities with isIndexable=true; the /wiki page itself is always listed',
  })
  entities!: WorldSitemapEntityDto[];
}
