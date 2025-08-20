export const msgExactlyOne = (a: string, b: string) =>
  `Exactly one of ${a} or ${b} must be provided`;

export const msgExactlyOneOf = (list: string[]) =>
  `Exactly one of [${list.join(', ')}] must be provided`;
