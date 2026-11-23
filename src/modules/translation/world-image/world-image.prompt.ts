/**
 * Промпт портрета героя (`F08-11a`, `product.md` §8, `tech.md` §10): внешность - только из текста
 * книги (блок «Внешность» страницы героя), место и время действия - из фактов анализа.
 *
 * Имени героя, названия книги и автора в промпте нет намеренно: по ним модель рисует лицо актёра
 * известной экранизации или обложку известного издания - ровно то, что запрещает §8.
 */
export interface WorldPortraitInput {
  appearance: string;
  settingPlace?: string | null;
  settingTime?: string | null;
}

/** Предел описания внешности в промпте: блок «Внешность» уже ограничен записью, это страховка. */
const APPEARANCE_MAX_CHARS = 2_000;

export function worldPortraitPrompt(input: WorldPortraitInput): string {
  const setting = [input.settingPlace, input.settingTime]
    .map((s) => (typeof s === 'string' ? s.trim() : ''))
    .filter(Boolean)
    .join('; ');
  return [
    'Editorial book illustration: a portrait of a fictional literary character.',
    `Appearance, as described in the text of the book: ${input.appearance.trim().slice(0, APPEARANCE_MAX_CHARS)}`,
    setting ? `Setting of the book: ${setting}.` : null,
    'Depict only what the description says; clothing and surroundings match the setting.',
    'The face is original and must not resemble any real person, actor or film or TV adaptation.',
    'Do not imitate the style of any recognizable artist or illustrator.',
    'No text, letters, captions, signatures or watermarks.',
    'Painted illustration, head and shoulders, plain muted background.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}
