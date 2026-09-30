import type { UpdateSeoDto } from '../dto/update-seo.dto';

/**
 * Поля `UpdateSeoDto` -> колонки `Seo` для `create`/`update`. Общий для путей записи, которые
 * принимают `UpdateSeoDto` целиком: `PUT /versions/:id/seo` и вложенный `seo` перевода автора.
 * Свой список полей у каждого пути молча терял остальные колонки (`LEGACY-401`, `T75`).
 * Страницы, теги и категории пишут `SeoInputDto` напрямую — через этот маппер они не идут.
 */
export function seoDtoToData(dto: UpdateSeoDto) {
  return {
    metaTitle: dto.metaTitle,
    metaDescription: dto.metaDescription,
    canonicalUrl: dto.canonicalUrl,
    robots: dto.robots,
    ogTitle: dto.ogTitle,
    ogDescription: dto.ogDescription,
    ogType: dto.ogType,
    ogUrl: dto.ogUrl,
    ogImageUrl: dto.ogImageUrl,
    ogImageAlt: dto.ogImageAlt,
    twitterCard: dto.twitterCard,
    twitterSite: dto.twitterSite,
    twitterCreator: dto.twitterCreator,
    eventName: dto.eventName,
    eventDescription: dto.eventDescription,
    eventStartDate: dto.eventStartDate ? new Date(dto.eventStartDate) : undefined,
    eventEndDate: dto.eventEndDate ? new Date(dto.eventEndDate) : undefined,
    eventUrl: dto.eventUrl,
    eventImageUrl: dto.eventImageUrl,
    eventLocationName: dto.eventLocationName,
    eventLocationStreet: dto.eventLocationStreet,
    eventLocationCity: dto.eventLocationCity,
    eventLocationRegion: dto.eventLocationRegion,
    eventLocationPostal: dto.eventLocationPostal,
    eventLocationCountry: dto.eventLocationCountry,
  };
}
