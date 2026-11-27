import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { Trim } from './trim.decorator';

/**
 * Поля блоков импорта JSON — общие для анализа книги (F03) и мира книги (F08). Строки обрезаются
 * по краям; пустая строка у необязательного поля — «нет значения», у обязательного — отказ
 * (тот же предикат «заполнено», что у ядра: `isFilled`, решение А9 `F03 | F03-1`).
 */

/** Ключ темы, героя или сущности мира: на него ссылаются `themeKeys`, `speakerKey`, `relations[].to`, адрес `/wiki/{key}`. */
export const BLOCK_KEY_REGEX = /^[a-z0-9-]{1,60}$/;

/**
 * Список ключей (`themeKeys` анализа, `characterKeys`/`themeKeys` мира): не больше `max`, каждый —
 * по `BLOCK_KEY_REGEX`. Есть ли такие темы и герои — проверка на слитой записи.
 */
export const KeyList = (max: number) =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(max),
    IsString({ each: true }),
    Matches(BLOCK_KEY_REGEX, {
      each: true,
      message: '$property must contain keys matching ^[a-z0-9-]{1,60}$',
    }),
  );

/** «Нет значения» необязательного поля: `undefined`, `null` и `''`. */
export const isAbsent = (value: unknown) => value === undefined || value === null || value === '';

/** Обязательная непустая (после обрезки) строка с пределом длины. */
export const RequiredText = (max: number) =>
  applyDecorators(Trim(), IsString(), IsNotEmpty(), MaxLength(max));

/** Необязательная строка: `undefined`, `null` и `''` (в том числе из пробелов) — «нет значения». */
export const OptionalText = (max: number) =>
  applyDecorators(
    Trim(),
    ValidateIf((_o, value) => !isAbsent(value)),
    IsString(),
    MaxLength(max),
  );

/** Ключ по `BLOCK_KEY_REGEX`. */
export const Key = () =>
  applyDecorators(
    Trim(),
    IsString(),
    Matches(BLOCK_KEY_REGEX, { message: '$property must match ^[a-z0-9-]{1,60}$' }),
  );

/** Необязательный список вложенных блоков не длиннее `max`. */
export const NestedList = (cls: () => new () => object, max: number) =>
  applyDecorators(
    IsOptional(),
    IsArray(),
    ArrayMaxSize(max),
    ValidateNested({ each: true }),
    Type(cls),
  );

/** Необязательный вложенный блок. */
export const Nested = (cls: () => new () => object) =>
  applyDecorators(IsOptional(), ValidateNested(), Type(cls));
