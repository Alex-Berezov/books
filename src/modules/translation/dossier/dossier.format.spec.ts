import { readFileSync } from 'fs';
import { join } from 'path';
import { DOSSIER_SHAPE, GLOSSARY_SHAPE, jsonSchemaOf } from './dossier.format';

/**
 * Формат досье описан дважды: формой проверки (`dossier.format.ts`) и DTO ответа
 * (`dto/dossier-data.dto.ts`). Сверка по снимку OpenAPI: поле, добавленное в одну половину без
 * другой, не дойдёт до Swagger и схемы фронта - спека краснеет.
 */
type Schema = {
  type?: string;
  $ref?: string;
  properties?: Record<string, Schema>;
  items?: Schema;
};

const api = JSON.parse(
  readFileSync(join(__dirname, '../../../../libs/api-client/api-schema.json'), 'utf8'),
) as { components: { schemas: Record<string, Schema> } };

function resolve(schema: Schema): Schema {
  if (!schema.$ref) return schema;
  return api.components.schemas[schema.$ref.split('/').pop() as string];
}

/** Пути полей объекта до листьев: `characters[].address[].to`. */
function fieldPaths(schema: Schema, path = ''): string[] {
  const s = resolve(schema);
  if (s.type === 'array' && s.items) return fieldPaths(s.items, `${path}[]`);
  if (!s.properties) return [path];
  return Object.entries(s.properties).flatMap(([key, field]) =>
    fieldPaths(field, path ? `${path}.${key}` : key),
  );
}

describe('dossier format and its response DTO describe the same fields', () => {
  it.each([
    ['DossierDataDto', DOSSIER_SHAPE],
    ['GlossaryDataDto', GLOSSARY_SHAPE],
  ] as const)('%s', (dto, shape) => {
    const fromShape = fieldPaths(jsonSchemaOf(shape) as Schema).sort();
    const fromDto = fieldPaths(api.components.schemas[dto]).sort();
    expect(fromDto).toEqual(fromShape);
  });
});
