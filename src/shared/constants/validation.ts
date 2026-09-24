export const msgExactlyOne = (a: string, b: string) =>
  `Exactly one of ${a} or ${b} must be provided`;

export const msgExactlyOneOf = (list: string[]) =>
  `Exactly one of [${list.join(', ')}] must be provided`;

// Короткое описание — простой текст из поля ввода: чистки HTML нет, только предел (LEGACY-414).
export const SHORT_TEXT_MAX_LENGTH = 10_000;
