import { readFileSync } from 'fs';
import { join } from 'path';
import {
  CONTRIBUTOR_EVENT_SNAPSHOT_KEYS,
  buildContributorEventSnapshot,
  parseContributorEventSnapshot,
} from './contributor-event-snapshot';

/**
 * `LEGACY-037`. Снимок связи участника — единственный след того, кого отвязали: строка связи
 * удаляется физически. Колонка `payload` объявлена как `Json?`, поэтому между писателем,
 * читателем и DTO компилятор не проверяет ничего — держат эти тесты.
 */
describe('ContributorEventSnapshot', () => {
  describe('buildContributorEventSnapshot — сборка на запись', () => {
    it('собирает все поля снимка и приводит дату привязки к ISO', () => {
      const snapshot = buildContributorEventSnapshot({
        canonicalName: 'Иванов, Иван',
        birthYear: 1901,
        deathYear: 1975,
        nationalityCountryCode: 'RU',
        notesRu: 'перевод с французского',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      expect(snapshot).toEqual({
        canonicalName: 'Иванов, Иван',
        birthYear: 1901,
        deathYear: 1975,
        nationalityCountryCode: 'RU',
        notesRu: 'перевод с французского',
        linkedAt: '2026-08-01T00:00:00.000Z',
      });
    });

    it('пустые поля связи кладёт как null, а не теряет ключ', () => {
      const snapshot = buildContributorEventSnapshot({});

      expect(Object.keys(snapshot).sort()).toEqual([...CONTRIBUTOR_EVENT_SNAPSHOT_KEYS].sort());
      expect(Object.values(snapshot).every((value) => value === null)).toBe(true);
    });

    it('ноль в годе жизни сохраняется, а не превращается в null', () => {
      const snapshot = buildContributorEventSnapshot({ birthYear: 0, deathYear: 0 });

      expect(snapshot.birthYear).toBe(0);
      expect(snapshot.deathYear).toBe(0);
    });
  });

  describe('parseContributorEventSnapshot — разбор на чтение', () => {
    it('читает снимок, записанный сборщиком, без потерь', () => {
      const written = buildContributorEventSnapshot({
        canonicalName: 'Иванов, Иван',
        birthYear: 1901,
        deathYear: 1975,
        nationalityCountryCode: 'RU',
        notesRu: 'перевод',
        createdAt: new Date('2026-08-01T00:00:00.000Z'),
      });

      expect(parseContributorEventSnapshot({ ...written })).toEqual(written);
    });

    it('не пропускает наружу чужие и битые значения', () => {
      const parsed = parseContributorEventSnapshot({
        canonicalName: { evil: true },
        birthYear: 'не число',
        deathYear: Number.NaN,
        nationalityCountryCode: 42,
        notesRu: null,
        linkedAt: '2026-08-01T00:00:00.000Z',
        secret: 'постороннее поле',
      });

      expect(parsed).toEqual({
        canonicalName: null,
        birthYear: null,
        deathYear: null,
        nationalityCountryCode: null,
        notesRu: null,
        linkedAt: '2026-08-01T00:00:00.000Z',
      });
      expect(parsed).not.toHaveProperty('secret');
    });

    it('не-объект и пустое значение дают null', () => {
      expect(parseContributorEventSnapshot(null)).toBeNull();
      expect(parseContributorEventSnapshot(undefined)).toBeNull();
      expect(parseContributorEventSnapshot(['не объект'])).toBeNull();
      expect(parseContributorEventSnapshot('строка')).toBeNull();
      expect(parseContributorEventSnapshot(7)).toBeNull();
    });

    it('ноль в годе жизни доезжает до ответа', () => {
      expect(parseContributorEventSnapshot({ birthYear: 0 })?.birthYear).toBe(0);
    });
  });

  /**
   * 🔴 Сторож против самого дефекта, ради которого заведён общий модуль: писатель кладёт
   * поле, читатель о нём не знает, и оно молча не доезжает до админки. Проверка идёт
   * по исходникам — раньше список полей жил двумя копиями в двух модулях.
   */
  describe('список полей един для писателя и читателя', () => {
    const read = (relativePath: string): string =>
      readFileSync(join(__dirname, relativePath), 'utf8');

    it('писатель не собирает payload своим литералом мимо общего сборщика', () => {
      const writer = read('../../modules/contributors/contributors.service.ts');

      expect(writer).toContain('buildContributorEventSnapshot');
      // Ключ снимка, вписанный в сервис руками, означал бы вторую копию списка.
      for (const key of CONTRIBUTOR_EVENT_SNAPSHOT_KEYS) {
        expect(writer).not.toContain(`${key}: link.`);
      }
    });

    it('читатель не разбирает payload своим литералом мимо общего разборщика', () => {
      const reader = read('../../modules/rights-intake/rights-profile-contributor-event.mapper.ts');

      expect(reader).toContain('parseContributorEventSnapshot');
      expect(reader).not.toContain("payload['");
    });

    it('DTO ответа объявляет ровно те же поля снимка', () => {
      const dto = read('../../modules/rights-intake/dto/rights-profile-response.dto.ts');
      const block = dto.slice(
        dto.indexOf('class RightsProfileContributorEventSnapshotDto'),
        dto.indexOf('class RightsProfileContributorEventDto'),
      );

      expect(block).not.toHaveLength(0);
      for (const key of CONTRIBUTOR_EVENT_SNAPSHOT_KEYS) {
        expect(block).toContain(`${key}!:`);
      }
    });
  });
});
