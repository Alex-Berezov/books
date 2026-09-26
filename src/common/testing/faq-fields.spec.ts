import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { FAQ_ANSWER_MAX_LENGTH, FAQ_QUESTION_MAX_LENGTH } from '../../shared/constants/validation';
import {
  AuthorFaqDto,
  AuthorTranslationDto,
} from '../../modules/author/dto/author-translation.dto';
import { UpdatePageDto } from '../../modules/pages/dto/update-page.dto';
import { TagFaqDto } from '../../modules/tags/dto/create-tag-translation.dto';
import { UpdateTagTranslationDto } from '../../modules/tags/dto/update-tag-translation.dto';
import { FaqItemDto } from '../../shared/dto/faq-item.dto';

// LEGACY-419: пары FAQ уходят в JSON-LD публичных страниц, длина без предела. Классов формы три — все под пределом.
const CASES: ReadonlyArray<[new () => object, 'question' | 'answer', number]> = [
  [FaqItemDto, 'question', FAQ_QUESTION_MAX_LENGTH],
  [FaqItemDto, 'answer', FAQ_ANSWER_MAX_LENGTH],
  [TagFaqDto, 'question', FAQ_QUESTION_MAX_LENGTH],
  [TagFaqDto, 'answer', FAQ_ANSWER_MAX_LENGTH],
  [AuthorFaqDto, 'question', FAQ_QUESTION_MAX_LENGTH],
  [AuthorFaqDto, 'answer', FAQ_ANSWER_MAX_LENGTH],
];

function constraints(errors: ValidationError[]): string[] {
  return errors.flatMap((e) => [
    ...Object.keys(e.constraints ?? {}),
    ...constraints(e.children ?? []),
  ]);
}

function pair(field: 'question' | 'answer', length: number): Record<string, string> {
  return { question: 'Q?', answer: 'A.', [field]: 'a'.repeat(length) };
}

describe('FAQ: предел длины вопроса и ответа (LEGACY-419)', () => {
  describe.each(CASES)('%p.%s', (Dto, field, max) => {
    it(`отклоняет длину больше ${max}`, () => {
      expect(constraints(validateSync(plainToInstance(Dto, pair(field, max + 1))))).toContain(
        'maxLength',
      );
    });

    it(`пропускает ровно ${max}`, () => {
      expect(validateSync(plainToInstance(Dto, pair(field, max)))).toEqual([]);
    });
  });

  // Предел на классе ничего не стоит, если вход до него не доходит: проверяется через DTO записи целиком.
  const WRITE_DTOS: ReadonlyArray<[string, new () => object]> = [
    ['UpdatePageDto', UpdatePageDto],
    ['UpdateTagTranslationDto', UpdateTagTranslationDto],
    ['AuthorTranslationDto', AuthorTranslationDto],
  ];

  it.each(WRITE_DTOS)('%s отклоняет длинный ответ внутри faq[]', (_name, Dto) => {
    const dto = plainToInstance(Dto, { faq: [pair('answer', FAQ_ANSWER_MAX_LENGTH + 1)] });
    expect(constraints(validateSync(dto))).toContain('maxLength');
  });
});
