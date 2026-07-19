import { generateWebSiteSchema } from './generateWebSiteSchema';

const ORIGINAL_ENV = process.env;

beforeEach(() => {
  process.env = { ...ORIGINAL_ENV, LOCAL_PUBLIC_BASE_URL: 'http://localhost:5000/static' };
});

afterEach(() => {
  process.env = ORIGINAL_ENV;
});

describe('generateWebSiteSchema', () => {
  it('contains WebSite type and id', () => {
    const schema = generateWebSiteSchema('en');
    expect(schema['@type']).toBe('WebSite');
    expect(schema['@id']).toContain('#website');
  });

  it('uses /catalog?q= for English', () => {
    const schema = generateWebSiteSchema('en');
    const action = schema.potentialAction as Record<string, unknown>;
    const target = action.target as Record<string, unknown>;
    expect(target.urlTemplate).toContain('/en/catalog?q={search_term_string}');
    expect(target.urlTemplate).not.toContain('/search?query=');
  });

  it('uses /catalog?q= for Russian', () => {
    const schema = generateWebSiteSchema('ru');
    const action = schema.potentialAction as Record<string, unknown>;
    const target = action.target as Record<string, unknown>;
    expect(target.urlTemplate).toContain('/ru/catalog?q={search_term_string}');
    expect(target.urlTemplate).not.toContain('/search?query=');
  });

  it('does not contain /search', () => {
    const schema = generateWebSiteSchema('en');
    const json = JSON.stringify(schema);
    expect(json).not.toContain('/search');
  });

  it('has query-input with required name=search_term_string', () => {
    const schema = generateWebSiteSchema('en');
    const action = schema.potentialAction as Record<string, unknown>;
    expect(action['query-input']).toBe('required name=search_term_string');
  });
});
