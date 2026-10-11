import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { SEARCH_QUERY_MAX_LENGTH } from '../../../shared/constants/validation';
import { BookCardsQueryDto } from './book-cards-query.dto';

// LEGACY-462: `q` без потолка уходил в ILIKE любой длины; длиннее потолка — обрезка, не 400.
describe('BookCardsQueryDto.q', () => {
  it('обрезается до потолка', () => {
    const dto = plainToInstance(BookCardsQueryDto, { q: 'a'.repeat(SEARCH_QUERY_MAX_LENGTH + 50) });
    expect(dto.q).toHaveLength(SEARCH_QUERY_MAX_LENGTH);
  });

  it('короче потолка — как есть', () => {
    expect(plainToInstance(BookCardsQueryDto, { q: 'hamlet' }).q).toBe('hamlet');
  });
});
