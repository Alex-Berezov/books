import { LATEST_RIGHTS_REPORT_SCHEMA_VERSION } from './rights-review-schema.registry';

export const RIGHTS_AGENT_MANIFEST_VERSION = '1.1';

export const RIGHTS_AGENT_MANIFEST_TYPE = 'BIBLIARIS_RIGHTS_CLEARANCE_INPUT';

export const RIGHTS_AGENT_EXPECTED_REPORT_SCHEMA_VERSION = LATEST_RIGHTS_REPORT_SCHEMA_VERSION;

/** Public URL of the machine-readable report schema for the version above. */
export const RIGHTS_AGENT_REPORT_SCHEMA_URL = `https://api.bibliaris.com/api/rights/agent/report-schema/${LATEST_RIGHTS_REPORT_SCHEMA_VERSION}`;

/** Public endpoint the external agent posts its report to. */
export const RIGHTS_AGENT_SUBMISSION_ENDPOINT =
  'https://api.bibliaris.com/api/rights/agent/submissions';
