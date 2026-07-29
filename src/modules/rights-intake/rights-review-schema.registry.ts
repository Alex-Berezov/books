import { RIGHTS_REPORT_SCHEMA_1_0 } from './rights-review-schema-1.0';

/** Every report schema version Bibliaris still accepts, oldest first. */
export const RIGHTS_REPORT_SCHEMA_VERSIONS = ['1.0'] as const;
export type RightsReportSchemaVersion = (typeof RIGHTS_REPORT_SCHEMA_VERSIONS)[number];

export const LATEST_RIGHTS_REPORT_SCHEMA_VERSION: RightsReportSchemaVersion = '1.0';

export const isSupportedReportSchemaVersion = (
  value: unknown,
): value is RightsReportSchemaVersion =>
  typeof value === 'string' && (RIGHTS_REPORT_SCHEMA_VERSIONS as readonly string[]).includes(value);

/** Machine-readable description of the report (JSON Schema 2020-12). Served publicly. */
export interface RightsReportSchemaDocument {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  schemaVersion: RightsReportSchemaVersion;
  type: 'object';
  required: string[];
  additionalProperties: boolean;
  properties: Record<string, unknown>;
  $defs?: Record<string, unknown>;
}

export const RIGHTS_REPORT_JSON_SCHEMAS: Record<
  RightsReportSchemaVersion,
  RightsReportSchemaDocument
> = {
  '1.0': RIGHTS_REPORT_SCHEMA_1_0,
};

export const getReportSchemaDocument = (version: string): RightsReportSchemaDocument | null =>
  isSupportedReportSchemaVersion(version) ? RIGHTS_REPORT_JSON_SCHEMAS[version] : null;
