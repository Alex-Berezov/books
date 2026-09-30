import { seoDtoToData } from './seo-dto-to-data.util';
import { getMetadataStorage } from 'class-validator';
import { UpdateSeoDto } from '../dto/update-seo.dto';

describe('seoDtoToData (LEGACY-401, T75)', () => {
  it('переносит каждое поле UpdateSeoDto в колонку, не теряя ни одного', () => {
    const full: Record<string, string> = {
      metaTitle: 'a',
      metaDescription: 'a',
      canonicalUrl: 'https://x.test/a',
      robots: 'index',
      ogTitle: 'a',
      ogDescription: 'a',
      ogType: 'website',
      ogUrl: 'https://x.test/a',
      ogImageUrl: 'https://x.test/a.png',
      ogImageAlt: 'a',
      twitterCard: 'summary',
      twitterSite: '@a',
      twitterCreator: '@a',
      eventName: 'a',
      eventDescription: 'a',
      eventUrl: 'https://x.test/e',
      eventImageUrl: 'https://x.test/e.png',
      eventLocationName: 'a',
      eventLocationStreet: 'a',
      eventLocationCity: 'a',
      eventLocationRegion: 'a',
      eventLocationPostal: 'a',
      eventLocationCountry: 'a',
    };
    const data = seoDtoToData({
      ...full,
      eventStartDate: '2026-10-01T00:00:00.000Z',
      eventEndDate: '2026-10-02T00:00:00.000Z',
    } as UpdateSeoDto);
    expect(data).toEqual({
      ...full,
      eventStartDate: new Date('2026-10-01T00:00:00.000Z'),
      eventEndDate: new Date('2026-10-02T00:00:00.000Z'),
    });
  });

  it('отсутствующие даты остаются undefined, а не Invalid Date', () => {
    const data = seoDtoToData({});
    expect(data.eventStartDate).toBeUndefined();
    expect(data.eventEndDate).toBeUndefined();
  });
  // Новое поле `UpdateSeoDto` без строки в маппере — снова тихая потеря колонки: имена полей
  // берутся из метаданных class-validator, а не из списка выше.
  it('знает каждое поле UpdateSeoDto', () => {
    const dtoFields = new Set(
      getMetadataStorage()
        .getTargetValidationMetadatas(UpdateSeoDto, '', true, false)
        .map((meta) => meta.propertyName),
    );
    expect(Object.keys(seoDtoToData({})).sort()).toEqual([...dtoFields].sort());
  });
});
