import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';

interface SchemaObject {
  required?: string[];
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
}

interface OperationObject {
  parameters?: Array<{ name?: string; required?: boolean }>;
  requestBody?: {
    content?: Record<
      string,
      {
        schema?: SchemaObject;
      }
    >;
  };
}

interface OpenApiDocument {
  paths: Record<string, { post?: OperationObject }>;
  components: {
    schemas: Record<string, SchemaObject>;
  };
}

const document = load(
  readFileSync(resolve(process.cwd(), 'integration/openapi.yaml'), 'utf8'),
) as OpenApiDocument;

function requestSchema(path: string, contentType: string): SchemaObject {
  const schema = document.paths[path]?.post?.requestBody?.content?.[contentType]?.schema;
  expect(schema, `${path} ${contentType} request schema`).toBeDefined();
  return schema as SchemaObject;
}

function expectStoredMaterialIds(schema: SchemaObject | undefined) {
  expect(schema).toMatchObject({
    type: 'array',
    minItems: 1,
    maxItems: 20,
    uniqueItems: true,
  });
  expect(schema?.items).toMatchObject({
    type: 'string',
    pattern: '^mat_[A-Za-z0-9_-]{8,64}$',
  });
}

describe('integration OpenAPI contract', () => {
  it('documents original-file outline upload alongside the legacy JSON path', () => {
    const path = document.paths['/api/integration/v1/outlines'];
    const content = path?.post?.requestBody?.content;

    expect(content).toHaveProperty('application/json');
    expect(content).toHaveProperty('multipart/form-data');

    const multipart = requestSchema('/api/integration/v1/outlines', 'multipart/form-data');
    expect(multipart.required).toEqual(
      expect.arrayContaining(['tenantId', 'requirement', 'files']),
    );
    expect(multipart.properties?.files).toMatchObject({
      minItems: 1,
      maxItems: 10,
    });
    expect(path?.post?.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'authorization', required: false }),
        expect.objectContaining({ name: 'x-openmaic-timestamp', required: false }),
        expect.objectContaining({ name: 'x-openmaic-nonce', required: false }),
        expect.objectContaining({ name: 'x-openmaic-signature', required: false }),
      ]),
    );
  });

  it('requires tenant-bound material uploads and returns their ids from outlines', () => {
    const multipart = requestSchema('/api/integration/v1/materials', 'multipart/form-data');
    expect(multipart.required).toContain('tenantId');
    expect(multipart.properties?.tenantId).toMatchObject({
      minLength: 1,
      maxLength: 100,
    });

    const response = document.components.schemas.OutlineResponse;
    expect(response.properties).toHaveProperty('materialIds');
    expect(response.properties).toHaveProperty('materials');
    expect(response.properties).toHaveProperty('warnings');
  });

  it.each(['OutlineRequest', 'CourseRequest', 'HandoffRequest'])(
    'constrains stored material ids on %s',
    (name) => {
      expectStoredMaterialIds(document.components.schemas[name]?.properties?.materialIds);
    },
  );
});
