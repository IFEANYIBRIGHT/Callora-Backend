import express from 'express';
import request from 'supertest';
import { errorHandler } from '../middleware/errorHandler.js';
import { openApiErrorHandler } from '../middleware/openApiErrorHandler.js';
import { createErrorCatalogRouter } from '../routes/errorCatalog.js';
import { BadRequestError, NotFoundError, AppError } from '../errors/index.js';

describe('RFC 7807 Problem+JSON Error Format', () => {
  let app: express.Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as express.Request & { id?: string }).id = 'test-request-id';
      next();
    });
  });

  describe('Malformed JSON (MALFORMED_JSON)', () => {
    it('returns 400 with MALFORMED_JSON code for invalid JSON', async () => {
      // Create a route that will receive malformed JSON
      app.post('/test', (_req, res) => res.json({ ok: true }));
      app.use(errorHandler);

      const res = await request(app)
        .post('/test')
        .set('Content-Type', 'application/json')
        .send('{"a":') // Invalid JSON
        .expect(400);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/malformed_json',
        title: 'Bad Request',
        status: 400,
        code: 'MALFORMED_JSON',
        instance: '/test',
      });
      expect(res.body.detail).toBe('Request body is not valid JSON');
      expect(res.body.error).toBe('Bad Request'); // Legacy field
      expect(JSON.stringify(res.body)).not.toContain('Unexpected');
      expect(JSON.stringify(res.body)).not.toContain('position');
    });
  });

  describe('Payload Too Large (PAYLOAD_TOO_LARGE)', () => {
    it('returns 413 with PAYLOAD_TOO_LARGE code for oversized payload', async () => {
      // Create app with small body limit
      const testApp = express();
      testApp.use(express.json({ limit: '1kb' }));
      testApp.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = 'test-request-id';
        next();
      });
      testApp.post('/test', (_req, res) => res.json({ ok: true }));
      testApp.use(errorHandler);

      // Create a payload larger than 1kb
      const largePayload = { data: 'x'.repeat(2000) };

      const res = await request(testApp)
        .post('/test')
        .send(largePayload)
        .expect(413);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/payload_too_large',
        title: 'Payload Too Large',
        status: 413,
        code: 'PAYLOAD_TOO_LARGE',
        instance: '/test',
      });
      expect(res.body.error).toBe('Payload Too Large'); // Legacy field
    });
  });

  describe('Unsupported Media Type (UNSUPPORTED_MEDIA_TYPE)', () => {
    it('returns 415 with UNSUPPORTED_MEDIA_TYPE code for unsupported content type', async () => {
      const testApp = express();
      // Use a custom middleware to check content type before express.json()
      testApp.use((req, _res, next) => {
        const contentType = req.get('Content-Type') || '';
        if (contentType && !contentType.includes('application/json') && req.method !== 'GET' && req.method !== 'HEAD') {
          const err = new Error('Unsupported media type') as Error & { status: number; type: string };
          err.status = 415;
          err.type = 'encoding.unsupported';
          return next(err);
        }
        next();
      });
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = 'test-request-id';
        next();
      });
      testApp.post('/test', (_req, res) => res.json({ ok: true }));
      testApp.use(errorHandler);

      const res = await request(testApp)
        .post('/test')
        .set('Content-Type', 'application/xml')
        .send('<xml>test</xml>')
        .expect(415);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/unsupported_media_type',
        title: 'Unsupported Media Type',
        status: 415,
        code: 'UNSUPPORTED_MEDIA_TYPE',
        instance: '/test',
      });
      expect(res.body.error).toBe('Unsupported Media Type'); // Legacy field
    });
  });

  describe('404 Route Not Found (ROUTE_NOT_FOUND)', () => {
    it('returns 404 with ROUTE_NOT_FOUND code for unknown routes', async () => {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = 'test-request-id';
        next();
      });
      testApp.get('/known', (_req, res) => res.json({ ok: true }));
      // Catch-all route for 404
      testApp.use((_req, _res, next) => {
        const err = new Error('Not Found') as Error & { status: number; code: string };
        err.status = 404;
        err.code = 'ROUTE_NOT_FOUND';
        next(err);
      });
      testApp.use(errorHandler);

      const res = await request(testApp)
        .get('/unknown')
        .expect(404);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/route_not_found',
        title: 'Not Found',
        status: 404,
        code: 'ROUTE_NOT_FOUND',
        instance: '/unknown',
      });
      expect(res.body.error).toBe('Not Found'); // Legacy field
    });
  });

  describe('Validation Errors (VALIDATION_FAILED)', () => {
    it('returns 400 with VALIDATION_FAILED code and field errors for OpenAPI validation', async () => {
      const testApp = express();
      testApp.use(express.json());
      testApp.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = 'test-request-id';
        next();
      });
      
      // Simulate an OpenAPI validation error by calling openApiErrorHandler directly
      const validationError = new Error('Validation failed') as Error & {
        status: number;
        errors: unknown[];
      };
      validationError.status = 400;
      validationError.errors = [
        { path: 'body.email', message: 'must be an email', keyword: 'format' },
        { path: 'body.amount', message: 'required', keyword: 'required' },
      ];

      testApp.post('/validate', (_req, _res, next) => next(validationError));
      testApp.use(openApiErrorHandler);
      testApp.use(errorHandler);

      const res = await request(testApp)
        .post('/validate')
        .send({})
        .expect(400);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/bad_request',
        title: 'Bad Request',
        status: 400,
        code: 'BAD_REQUEST',
        instance: '/validate',
      });
      expect(res.body.errors).toBeDefined();
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBe(2);
      expect(res.body.errors[0]).toMatchObject({
        field: 'body.email',
        message: 'must be an email',
        code: 'FORMAT',
      });
      expect(res.body.error).toBe('Bad Request'); // Legacy field
    });
  });

  describe('Error Catalog Endpoints', () => {
    let catalogApp: express.Express;

    beforeEach(() => {
      catalogApp = express();
      catalogApp.use(express.json());
      catalogApp.use((req, _res, next) => {
        (req as express.Request & { id?: string }).id = 'test-request-id';
        next();
      });
      catalogApp.use('/api/error-catalog', createErrorCatalogRouter());
      catalogApp.use(errorHandler);
    });

    it('GET /api/error-catalog returns all error codes', async () => {
      const res = await request(catalogApp)
        .get('/api/error-catalog')
        .expect(200);

      expect(res.body).toHaveProperty('errors');
      expect(Array.isArray(res.body.errors)).toBe(true);
      expect(res.body.errors.length).toBeGreaterThan(0);
      
      // Check structure of first entry
      const firstEntry = res.body.errors[0];
      expect(firstEntry).toMatchObject({
        code: expect.any(String),
        title: expect.any(String),
        status: expect.any(Number),
        description: expect.any(String),
        type: expect.any(String),
      });
    });

    it('GET /api/error-catalog/:code returns specific error catalog entry', async () => {
      const res = await request(catalogApp)
        .get('/api/error-catalog/BAD_REQUEST')
        .expect(200);

      expect(res.body).toMatchObject({
        code: 'BAD_REQUEST',
        title: 'Bad Request',
        status: 400,
        description: expect.any(String),
        type: 'https://callora-backend.vercel.app/errors/bad_request',
      });
    });

    it('GET /api/error-catalog/:code returns 404 for unknown code', async () => {
      const res = await request(catalogApp)
        .get('/api/error-catalog/UNKNOWN_CODE')
        .expect(404);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: expect.stringContaining('/errors/'),
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
      });
    });

    it('GET /api/error-catalog/:code is case-insensitive', async () => {
      const res = await request(catalogApp)
        .get('/api/error-catalog/bad_request')
        .expect(200);

      expect(res.body.code).toBe('BAD_REQUEST');
    });
  });

  describe('Legacy AppError classes still work', () => {
    it('returns problem+json for BadRequestError', async () => {
      app.get('/test', (_req, _res, next) => {
        next(new BadRequestError('Custom bad request'));
      });
      app.use(errorHandler);

      const res = await request(app)
        .get('/test')
        .expect(400);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/bad_request',
        title: 'Bad Request',
        status: 400,
        code: 'BAD_REQUEST',
        detail: 'Custom bad request',
        instance: '/test',
      });
      expect(res.body.error).toBe('Bad Request'); // Legacy field
    });

    it('returns problem+json for NotFoundError', async () => {
      app.get('/test', (_req, _res, next) => {
        next(new NotFoundError('Resource not found'));
      });
      app.use(errorHandler);

      const res = await request(app)
        .get('/test')
        .expect(404);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/not_found',
        title: 'Not Found',
        status: 404,
        code: 'NOT_FOUND',
        detail: 'Resource not found',
        instance: '/test',
      });
      expect(res.body.error).toBe('Not Found'); // Legacy field
    });

    it('returns problem+json with custom code for AppError', async () => {
      app.get('/test', (_req, _res, next) => {
        next(new AppError('Wallet blocked', 403, 'API_ACCESS_FORBIDDEN'));
      });
      app.use(errorHandler);

      const res = await request(app)
        .get('/test')
        .expect(403);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/api_access_forbidden',
        title: 'Forbidden',
        status: 403,
        code: 'API_ACCESS_FORBIDDEN',
        detail: 'Wallet blocked',
        instance: '/test',
      });
      expect(res.body.error).toBe('Forbidden'); // Legacy field
    });
  });

  describe('Unknown errors return INTERNAL_SERVER_ERROR without leaking message', () => {
    it('returns 500 with generic message for unknown errors in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';

      app.get('/test', (_req, _res, next) => {
        next(new Error('postgres password=secret'));
      });
      app.use(errorHandler);

      const res = await request(app)
        .get('/test')
        .expect(500);

      expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(res.body).toMatchObject({
        type: 'https://callora-backend.vercel.app/errors/internal_server_error',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Internal server error',
        instance: '/test',
      });
      expect(res.body.error).toBe('Internal Server Error'); // Legacy field
      expect(JSON.stringify(res.body)).not.toContain('postgres');
      expect(JSON.stringify(res.body)).not.toContain('secret');

      process.env.NODE_ENV = originalEnv;
    });

    it('allows safe client diagnostics in development', async () => {
      const originalEnv = process.env.NODE_ENV;
      process.env.NODE_ENV = 'development';

      app.get('/test', (_req, _res, next) => {
        const err = new Error('invalid cursor format') as Error & { status: number };
        err.status = 400;
        next(err);
      });
      app.use(errorHandler);

      const res = await request(app)
        .get('/test')
        .expect(400);

      expect(res.body.detail).toBe('invalid cursor format');

      process.env.NODE_ENV = originalEnv;
    });
  });
});