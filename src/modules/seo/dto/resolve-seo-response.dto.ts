import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Response DTO — только Swagger, без `class-validator` (`STYLE_GUIDE.md` §7).
 *
 * Форма собрана по шести резолверам `SeoService.resolvePublic`
 * (`src/modules/seo/seo.service.ts`) и совпадает с набором полей верхнего
 * уровня, который зафиксирован спекой `resolvePublic: форма ответа каждой
 * ветки (LEGACY-317)` в `seo.service.spec.ts`:
 *
 * | ветка                      | meta | openGraph | twitter | schema | hreflangs | breadcrumbPath |
 * | -------------------------- | ---- | --------- | ------- | ------ | --------- | -------------- |
 * | `version`                  | да   | да        | да      | да     | нет       | нет            |
 * | `book`                     | да   | да        | да      | да     | да        | да             |
 * | `page`                     | да   | да        | да      | да     | да        | нет            |
 * | `category`/`genre`/`collection` | да | да     | да      | да     | да        | да             |
 * | `tag`                      | да   | да        | да      | да     | да        | да             |
 * | `catalog`                  | да   | да        | да      | да     | да        | нет            |
 *
 * ⚠️ Отличия веток **вычитающие**: конверт один, часть веток не отдаёт
 * `hreflangs` и/или `breadcrumbPath`. Поэтому они и стоят `@ApiPropertyOptional`,
 * а не разведены в шесть схем через `oneOf`. У `version` адреса на других языках
 * нет вовсе (`/versions/:id` один на все языки), у `page` и `catalog` нет
 * предков в крошках — это поведение, а не недоделка.
 *
 * ⚠️ Ветка `book` при отказе необязательного блока помечает ответ символом
 * (`markDegraded`, `LEGACY-305`). Символ не сериализуется `JSON.stringify`,
 * поэтому в теле ответа его нет и в схеме ему места нет тоже.
 */
export class SeoResolveMetaDto {
  @ApiProperty({ type: String, description: 'Заголовок страницы (`<title>`).' })
  title!: string;

  @ApiPropertyOptional({
    description: 'Мета-описание. Отсутствует, если его нет ни в записи `Seo`, ни в тексте.',
  })
  description?: string;

  @ApiProperty({
    type: String,
    example: 'index, follow',
    description: 'Значение мета-тега `robots`.',
  })
  robots!: string;

  @ApiProperty({ type: String, description: 'Канонический адрес страницы, абсолютный.' })
  canonicalUrl!: string;
}

export class SeoResolveOpenGraphImageDto {
  @ApiProperty({
    type: String,
    description: 'Абсолютный адрес картинки: `Seo.ogImageUrl` или обложка версии.',
  })
  url!: string;

  @ApiProperty({
    type: String,
    description: '`Seo.ogImageAlt`, а при его отсутствии — заголовок страницы.',
  })
  alt!: string;
}

export class SeoResolveOpenGraphDto {
  @ApiProperty({ type: String })
  title!: string;

  @ApiPropertyOptional({ type: String })
  description?: string;

  @ApiProperty({
    enum: ['website', 'book'],
    description: '`book` — у страницы книги и версии, `website` — у остальных.',
  })
  type!: 'website' | 'book';

  @ApiProperty({
    type: String,
    description: '`Seo.ogUrl`, а при его отсутствии — канонический адрес.',
  })
  url!: string;

  @ApiPropertyOptional({ type: SeoResolveOpenGraphImageDto })
  image?: SeoResolveOpenGraphImageDto;
}

export class SeoResolveTwitterDto {
  @ApiProperty({
    example: 'summary_large_image',
    description: 'Тип карточки: большой становится от наличия картинки, а не от типа страницы.',
  })
  card!: string;

  @ApiPropertyOptional({ type: String })
  site?: string;

  @ApiPropertyOptional({ type: String })
  creator?: string;

  @ApiPropertyOptional({ type: String })
  image?: string;
}

export class SeoResolveHreflangDto {
  @ApiProperty({ enum: ['alternate'] })
  rel!: 'alternate';

  @ApiProperty({ type: String, example: 'en', description: 'Код языка либо `x-default`.' })
  hreflang!: string;

  @ApiProperty({ type: String, description: 'Абсолютный адрес страницы на этом языке.' })
  href!: string;
}

export class SeoResolveBreadcrumbDto {
  @ApiProperty({ type: String })
  name!: string;

  @ApiProperty({
    type: String,
    description: 'Слаг звена — последний сегмент его канонического адреса.',
  })
  slug!: string;

  @ApiPropertyOptional({
    enum: ['category', 'genre', 'collection'],
    description: 'Тип звена. Отдаёт только ветка `book`; у страниц термина его нет.',
  })
  type?: 'category' | 'genre' | 'collection';
}

export class SeoResolveResponseDto {
  @ApiProperty({ type: SeoResolveMetaDto })
  meta!: SeoResolveMetaDto;

  @ApiProperty({ type: SeoResolveOpenGraphDto })
  openGraph!: SeoResolveOpenGraphDto;

  @ApiProperty({ type: SeoResolveTwitterDto })
  twitter!: SeoResolveTwitterDto;

  /**
   * ⚠️ Граф JSON-LD описан непрозрачным объектом намеренно. Состав `@graph`
   * у каждой ветки свой (`Book`, `CollectionPage`, `WebSite`, `BreadcrumbList`,
   * `Event`), и выписать его классом значило бы выдумать форму, которой в коде
   * нет. `additionalProperties: true` — это «схема сознательно не описывает поля»,
   * в отличие от голого `type: object`, который означает «описание потерялось».
   */
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Граф JSON-LD: `@context` и `@graph`. Состав графа зависит от типа страницы, ' +
      'схемой не описывается.',
  })
  schema!: Record<string, unknown>;

  @ApiPropertyOptional({
    type: SeoResolveHreflangDto,
    isArray: true,
    description: 'Альтернативные языковые адреса. Ветка `version` их не отдаёт: адрес у неё один.',
  })
  hreflangs?: SeoResolveHreflangDto[];

  @ApiPropertyOptional({
    type: SeoResolveBreadcrumbDto,
    isArray: true,
    description:
      'Крошки между главной и самой страницей. Отдают `book` и страницы термина; ' +
      'у `version`, `page` и `catalog` поля нет.',
  })
  breadcrumbPath?: SeoResolveBreadcrumbDto[];
}
