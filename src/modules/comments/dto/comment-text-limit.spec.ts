import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { COMMENT_TEXT_MAX_LENGTH } from '../../../shared/constants/validation';
import { CreateCommentDto } from './create-comment.dto';
import { UpdateCommentDto } from './update-comment.dto';

const textErrors = (cls: new () => object, text: string) =>
  validateSync(
    plainToInstance(cls, {
      text,
      bookVersionId: '11111111-1111-4111-8111-111111111111',
    }),
  ).filter((e) => e.property === 'text');

// LEGACY-462: текст комментария без верхней границы принимался любой длины.
describe('comment DTO: потолок длины текста (LEGACY-462)', () => {
  it.each([
    ['CreateCommentDto', CreateCommentDto],
    ['UpdateCommentDto', UpdateCommentDto],
  ])('%s: ровно потолок проходит, на символ больше — нет', (_name, cls) => {
    expect(textErrors(cls, 'a'.repeat(COMMENT_TEXT_MAX_LENGTH))).toEqual([]);
    expect(textErrors(cls, 'a'.repeat(COMMENT_TEXT_MAX_LENGTH + 1))).not.toEqual([]);
  });
});
