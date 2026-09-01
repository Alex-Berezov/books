import { materializationFailedMessageRu } from './rights-review-import.constants';

/**
 * Посадка на подстановку названия интейка в постоянную фразу (`LEGACY-197`).
 *
 * 🔴 Название — свободный текст, который вводит человек. `String.replace`
 * со **строковым** вторым аргументом разбирает в нём `$&`, `` $` ``, `$'` и `$$`
 * как шаблоны подстановки, и результат уходит в базу
 * (`RightsNotification.messageRu`), то есть портится навсегда. Проверяются
 * именно эти четыре последовательности, а не «какое-нибудь название»:
 * на обычном тексте ошибка не воспроизводится вовсе.
 */
describe('materializationFailedMessageRu', () => {
  it('подставляет обычное название как есть', () => {
    expect(materializationFailedMessageRu('Оскар Уайльд')).toContain('«Оскар Уайльд»');
  });

  it('не разбирает $-последовательности в названии как шаблоны подстановки', () => {
    const cases = ['A $& B', "X $' Y", 'P $` Q', 'D $$ E'];

    for (const title of cases) {
      const message = materializationFailedMessageRu(title);
      expect(message).toContain(`«${title}»`);
      // Плейсхолдер не всплывает обратно: `$&` возвращал в текст само `%title%`.
      expect(message).not.toContain('%title%');
    }
  });

  it('не склеивает в середину куски самого шаблона', () => {
    // `$'` подставлял хвост шаблона, `` $` `` — его начало. И то и другое
    // видно по тому, что слово «импортирован» встречается дважды.
    const message = materializationFailedMessageRu("X $' Y");
    expect(message.split('импортирован')).toHaveLength(2);
    expect(materializationFailedMessageRu('P $` Q').split('Отчёт по интейку')).toHaveLength(2);
  });

  it('название подставляется ровно один раз', () => {
    const message = materializationFailedMessageRu('ЫЫЫ');
    expect(message.split('ЫЫЫ')).toHaveLength(2);
  });
});
