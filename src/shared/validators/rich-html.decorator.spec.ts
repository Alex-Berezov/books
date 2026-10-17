import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateBookSummaryDto } from '../../modules/book-summary/dto/update-book-summary.dto';
import { richHtmlText } from '../sanitize/rich-html-text';

const errorsFor = (summary: unknown) =>
  validateSync(plainToInstance(UpdateBookSummaryDto, { summary })).filter(
    (e) => e.property === 'summary',
  );

describe('RichHtmlHasText', () => {
  it.each([
    '',
    '   ',
    '<p></p>',
    '<p>&nbsp;</p>',
    '<p>\u00a0</p>',
    '<h2> </h2><p><br></p>',
    '<p>&#32;</p>',
    '<p>&#x20;</p>',
    '<p>&#9;</p>',
    '<p>&#0160;</p>',
    '<p>&#x00A0;</p>',
    '<p>&ensp;&emsp;&thinsp;</p>',
    '<p>&#8203;</p>',
    '<p>\u200b\ufeff</p>',
    '<p>&shy;&zwnj;</p>',
  ])('отбивает пересказ без видимого текста: %j', (summary) => {
    expect(errorsFor(summary)).toHaveLength(1);
  });

  it('текстом считаются расшифрованные знаки и неизвестные сущности', () => {
    expect(errorsFor('<p>&amp;</p>')).toHaveLength(0);
    expect(errorsFor('<p>&#1040;</p>')).toHaveLength(0);
    expect(errorsFor('<p>&hellip;</p>')).toHaveLength(0);
  });

  it('пропускает пересказ с текстом', () => {
    expect(errorsFor('<h2>Часть первая</h2><p>Герой приезжает в город.</p>')).toHaveLength(0);
  });

  it('текст считается после санитайзера: вырезанный скрипт текстом не считается', () => {
    expect(errorsFor('<script>alert(1)</script>')).toHaveLength(1);
  });
});

describe('richHtmlText', () => {
  it('снимает теги и неразрывные пробелы', () => {
    expect(richHtmlText('<p>&nbsp;Hello <b>world</b>&#160;</p>')).toBe('Hello world');
  });
});
