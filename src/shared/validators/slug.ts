export const SLUG_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
export const SLUG_REGEX = new RegExp(SLUG_PATTERN);
export const SLUG_REGEX_README =
  'Нижний регистр: латиница и цифры, разделитель — дефис. Без пробелов, без двойных/крайних дефисов. Примеры: "harry-potter", "book-123"';
