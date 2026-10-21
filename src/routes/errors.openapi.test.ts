import fs from 'node:fs';
import path from 'node:path';

type JsonObject = Record<string, unknown>;

describe('OpenAPI examples for /api/error-catalog', () => {
  const openApiPath = path.join(process.cwd(), 'docs', 'openapi.json');

  function readSpec(): JsonObject {
    return JSON.parse(fs.readFileSync(openApiPath, 'utf8')) as JsonObject;
  }

  function asObject(value: unknown): JsonObject {
    return value as JsonObject;
  }

  test('documents list example for GET /api/error-catalog', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/error-catalog']).get as JsonObject;
    const response200 = asObject(asObject(operation.responses)['200']);
    const content = asObject(asObject(response200.content)['application/json']);
    expect(content.schema).toBeDefined();
    expect(content.schema).toEqual(expect.objectContaining({
      $ref: '#/components/schemas/ErrorCatalogResponse',
    }));
  });

  test('documents found and not-found examples for GET /api/error-catalog/{code}', () => {
    const spec = readSpec();
    const operation = asObject(asObject(spec.paths)['/api/error-catalog/{code}']).get as JsonObject;

    const response200 = asObject(asObject(operation.responses)['200']);
    const content200 = asObject(asObject(response200.content)['application/json']);
    expect(content200.schema).toEqual(expect.objectContaining({
      $ref: '#/components/schemas/ErrorCatalogEntry',
    }));

    const response404 = asObject(asObject(operation.responses)['404']);
    const content404 = asObject(asObject(response404.content)['application/problem+json']);
    expect(content404.schema).toEqual(expect.objectContaining({
      $ref: '#/components/schemas/Problem',
    }));
  });
});
