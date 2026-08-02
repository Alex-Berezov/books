import {
  LATEST_RIGHTS_REPORT_SCHEMA_VERSION,
  RIGHTS_REPORT_JSON_SCHEMAS,
  RIGHTS_REPORT_SCHEMA_VERSIONS,
  getReportSchemaDocument,
  isSupportedReportSchemaVersion,
} from './rights-review-schema.registry';

const MANIFEST_REQUIRED_TOP_LEVEL_FIELDS = [
  'schemaVersion',
  'intakeId',
  'overallStatus',
  'publicationGate',
  'summaryRu',
  'conclusionRu',
  'sourceAssessment',
  'languageAssessments',
  'componentAssessments',
  'territoryDecisions',
  'requiredActions',
  'evidence',
  'confidence',
  'nextReviewAt',
];

describe('rights report schema registry', () => {
  it('lists the latest version among the supported ones', () => {
    expect(RIGHTS_REPORT_SCHEMA_VERSIONS).toContain(LATEST_RIGHTS_REPORT_SCHEMA_VERSION);
    expect(isSupportedReportSchemaVersion(LATEST_RIGHTS_REPORT_SCHEMA_VERSION)).toBe(true);
    expect(isSupportedReportSchemaVersion('2.0')).toBe(false);
  });

  it('has a schema document for every supported version', () => {
    for (const version of RIGHTS_REPORT_SCHEMA_VERSIONS) {
      expect(RIGHTS_REPORT_JSON_SCHEMAS[version]).toBeDefined();
      expect(getReportSchemaDocument(version)).toBe(RIGHTS_REPORT_JSON_SCHEMAS[version]);
    }
    expect(getReportSchemaDocument('2.0')).toBeNull();
  });

  it('ends every $id with its own version number', () => {
    for (const version of RIGHTS_REPORT_SCHEMA_VERSIONS) {
      const document = RIGHTS_REPORT_JSON_SCHEMAS[version];
      expect(document.$id.endsWith(`/${version}`)).toBe(true);
      expect(document.schemaVersion).toBe(version);
    }
  });

  /**
   * WP-G.6: манифест по-прежнему просит у агента все 14 блоков, но два из них сервер больше
   * не требует — их отсутствие ничего не ломает. Расхождение допустимо ровно в эту сторону
   * и ровно на эти два поля: схема не может требовать больше, чем просит манифест.
   */
  it('requires a subset of the top-level fields the agent manifest announces', () => {
    const document = RIGHTS_REPORT_JSON_SCHEMAS[LATEST_RIGHTS_REPORT_SCHEMA_VERSION];

    expect(document.required).toHaveLength(12);
    expect(
      MANIFEST_REQUIRED_TOP_LEVEL_FIELDS.filter((field) => !document.required.includes(field)),
    ).toEqual(['requiredActions', 'evidence']);
    expect(
      document.required.every((field) => MANIFEST_REQUIRED_TOP_LEVEL_FIELDS.includes(field)),
    ).toBe(true);
    expect(document.additionalProperties).toBe(true);
  });
});
