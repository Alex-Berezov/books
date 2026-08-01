import { RIGHTS_REPORT_SCHEMA_1_0 } from './rights-review-schema-1.0';
import { REQUIRED_REPORT_FIELDS } from './rights-review-required-fields';

/**
 * WP-6.2 (R4-01): опубликованная схема и рантайм-валидатор описывают один контракт.
 * Спека держит их на одном списке — расхождение снова стало бы обнаружимым только
 * падением материализации на проде.
 */
describe('rights report required fields', () => {
  const properties = RIGHTS_REPORT_SCHEMA_1_0.properties as Record<string, Record<string, unknown>>;

  const itemsOf = (block: string): Record<string, unknown> =>
    properties[block]['items'] as Record<string, unknown>;

  it('root required list matches the schema document', () => {
    expect(RIGHTS_REPORT_SCHEMA_1_0.required).toEqual([...REQUIRED_REPORT_FIELDS.root]);
  });

  it.each([
    ['languageAssessments', REQUIRED_REPORT_FIELDS.languageAssessments],
    ['componentAssessments', REQUIRED_REPORT_FIELDS.componentAssessments],
    ['territoryDecisions', REQUIRED_REPORT_FIELDS.territoryDecisions],
    ['requiredActions', REQUIRED_REPORT_FIELDS.requiredActions],
    ['evidence', REQUIRED_REPORT_FIELDS.evidence],
    ['licenses', REQUIRED_REPORT_FIELDS.licenses],
  ])('%s items require exactly the shared list', (block, fields) => {
    expect(itemsOf(block)['required']).toEqual([...fields]);
  });

  it('sourceAssessment requires exactly the shared list', () => {
    expect(properties['sourceAssessment']['required']).toEqual([
      ...REQUIRED_REPORT_FIELDS.sourceAssessment,
    ]);
  });

  it('component territory assessments require exactly the shared list', () => {
    const componentItems = itemsOf('componentAssessments');
    const componentProperties = componentItems['properties'] as Record<
      string,
      Record<string, unknown>
    >;
    const territoryItems = componentProperties['territoryAssessments']['items'] as Record<
      string,
      unknown
    >;

    expect(territoryItems['required']).toEqual([
      ...REQUIRED_REPORT_FIELDS.componentTerritoryAssessments,
    ]);
  });

  it('contributors require exactly the shared list', () => {
    const defs = RIGHTS_REPORT_SCHEMA_1_0.$defs as Record<string, Record<string, unknown>>;
    expect(defs['contributor']['required']).toEqual([...REQUIRED_REPORT_FIELDS.contributors]);
  });

  // Поля, которые NOT NULL в БД, не могут быть nullable в контракте: `null` дошёл бы
  // до Prisma и упал бы там же, где раньше падало отсутствие поля.
  it('fields required by the contract are not declared nullable', () => {
    const nonNullable: Array<[string, string]> = [
      ['componentAssessments', 'titleRu'],
      ['territoryDecisions', 'reasonRu'],
    ];

    for (const [block, field] of nonNullable) {
      const blockProperties = itemsOf(block)['properties'] as Record<
        string,
        Record<string, unknown>
      >;
      expect(blockProperties[field]['type']).toBe('string');
    }
  });
});
