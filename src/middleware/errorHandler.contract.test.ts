import { describe, expect, it, jest } from '@jest/globals';
import type { NextFunction, Request, Response } from 'express';
import { AppError, BadRequestError, ConflictError, TooManyRequestsError } from '../errors/index.js';
import { ValidationError } from './validate.js';
import { errorHandler } from './errorHandler.js';

function response() {
  const result = { statusCode: 200, body: undefined as unknown, sent: false, destroyedWith: undefined as unknown };
  const value = {
    headersSent: false,
    writableEnded: false,
    destroyed: false,
    setHeader: jest.fn(),
    destroy(err?: unknown) { result.destroyedWith = err; value.destroyed = true; return value; },
    status(code: number) { result.statusCode = code; return value; },
    json(body: unknown) { result.body = body; result.sent = true; return value; },
  } as unknown as Response;
  return { result, value };
}

function request(id = 'req-123'): Request {
  return { id, originalUrl: '/test' } as Request;
}

function body(result: { body: unknown }): Record<string, unknown> {
  return result.body as Record<string, unknown>;
}

describe('errorHandler contract', () => {
  it('maps a trusted bad request to the problem+json envelope', () => {
    const output = response();
    errorHandler(new BadRequestError('amount is invalid'), request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(400);
    expect(body(output.result)).toEqual(expect.objectContaining({
      type: 'https://callora-backend.vercel.app/errors/bad_request',
      title: 'Bad Request',
      status: 400,
      code: 'BAD_REQUEST',
      detail: 'amount is invalid',
      instance: '/test',
    }));
    expect(body(output.result).error).toBe('Bad Request'); // Legacy field
  });

  it('preserves a stable domain-specific public code', () => {
    const output = response();
    errorHandler(new AppError('wallet blocked', 403, 'API_ACCESS_FORBIDDEN'), request('domain-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(body(output.result)).toEqual(expect.objectContaining({
      type: 'https://callora-backend.vercel.app/errors/api_access_forbidden',
      title: 'Forbidden',
      status: 403,
      code: 'API_ACCESS_FORBIDDEN',
      detail: 'wallet blocked',
      instance: '/test',
    }));
    expect(body(output.result).error).toBe('Forbidden'); // Legacy field
    expect(body(output.result).instance).toBe('/test');
  });

  it('maps conflict and rate-limit errors to their public codes', () => {
    const conflict = response();
    errorHandler(new ConflictError('duplicate request'), request(), conflict.value, jest.fn() as unknown as NextFunction);
    expect((body(conflict.result) as Record<string, unknown>).code).toBe('CONFLICT');
    const limited = response();
    errorHandler(new TooManyRequestsError('slow down'), request(), limited.value, jest.fn() as unknown as NextFunction);
    expect(limited.result.statusCode).toBe(429);
    expect((body(limited.result) as Record<string, unknown>).code).toBe('TOO_MANY_REQUESTS');
  });

  it('returns field-level validation details without a stack', () => {
    const output = response();
    const error = new ValidationError([
      { field: 'body.email', message: 'must be an email', code: 'INVALID_FORMAT' },
      { field: 'body.amount', message: 'required', code: 'REQUIRED' },
    ]);
    errorHandler(error, request('validation-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(400);
    expect(body(output.result)).toEqual(expect.objectContaining({
      type: 'https://callora-backend.vercel.app/errors/validation_error',
      title: 'Bad Request',
      status: 400,
      code: 'VALIDATION_ERROR',
      instance: '/test',
    }));
    expect((body(output.result) as Record<string, unknown>).errors).toEqual([
      { field: 'body.email', message: 'must be an email', code: 'INVALID_FORMAT' },
      { field: 'body.amount', message: 'required', code: 'REQUIRED' },
    ]);
    expect(JSON.stringify(output.result.body)).not.toContain('stack');
  });

  it('uses a generic message for unknown production failures', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const output = response();
      errorHandler(new Error('postgres password=secret'), request('prod-id'), output.value, jest.fn() as unknown as NextFunction);
      expect(output.result.statusCode).toBe(500);
      expect((body(output.result) as Record<string, unknown>).detail).toBe('Internal server error');
      expect(JSON.stringify(output.result.body)).not.toContain('postgres');
      expect(JSON.stringify(output.result.body)).not.toContain('secret');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('allows safe client diagnostics in development but never server failures', () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'development';
    try {
      const client = response();
      const clientError = Object.assign(new Error('invalid cursor format'), { status: 400 });
      errorHandler(clientError, request(), client.value, jest.fn() as unknown as NextFunction);
      expect((body(client.result) as Record<string, unknown>).detail).toBe('invalid cursor format');
      const server = response();
      errorHandler(new Error('service crashed'), request(), server.value, jest.fn() as unknown as NextFunction);
      expect((body(server.result) as Record<string, unknown>).detail).toBe('Internal server error');
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it('derives a public fallback code for an unknown status', () => {
    const output = response();
    const error = new Error('client failure') as Error & { status: number };
    error.status = 418;
    errorHandler(error, request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(418);
    expect((body(output.result) as Record<string, unknown>).code).toBe('BAD_REQUEST');
  });

  it('does not overwrite a response that already sent headers', () => {
    const output = response();
    (output.value as Response).headersSent = true;
    const failure = new Error('already handled');
    errorHandler(failure, request(), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.sent).toBe(false);
    // Nothing can be written after headers, so the stream is terminated instead.
    expect(output.result.destroyedWith).toBe(failure);
  });

  it('keeps error responses JSON-compatible for null and non-Error throws', () => {
    for (const thrown of [null, 'failure', 42, { reason: 'failure' }]) {
      const output = response();
      errorHandler(thrown, request('coercion-id'), output.value, jest.fn() as unknown as NextFunction);
      expect(output.result.statusCode).toBe(500);
      expect(body(output.result)).toEqual(expect.objectContaining({
        type: 'https://callora-backend.vercel.app/errors/internal_server_error',
        title: 'Internal Server Error',
        status: 500,
        code: 'INTERNAL_SERVER_ERROR',
        detail: 'Internal server error',
        instance: '/test',
      }));
      expect(body(output.result).error).toBe('Internal Server Error'); // Legacy field
    }
  });

  it('handles status-bearing upstream errors without echoing their message', () => {
    const output = response();
    const upstream = Object.assign(new Error('upstream api-key leaked'), { status: 502 });
    errorHandler(upstream, request('upstream-id'), output.value, jest.fn() as unknown as NextFunction);
    expect(output.result.statusCode).toBe(502);
    expect(body(output.result)).toEqual(expect.objectContaining({
      type: 'https://callora-backend.vercel.app/errors/bad_gateway',
      title: 'Bad Gateway',
      status: 502,
      code: 'BAD_GATEWAY',
      detail: 'Internal server error',
      instance: '/test',
    }));
    expect(body(output.result).error).toBe('Bad Gateway'); // Legacy field
  });

  it('keeps the request id stable across every error class', () => {
    for (const error of [new BadRequestError(), new ConflictError(), new TooManyRequestsError()]) {
      const output = response();
      errorHandler(error, request('stable-correlation'), output.value, jest.fn() as unknown as NextFunction);
      expect(body(output.result).instance).toBe('/test');
      expect(body(output.result).type).toBeDefined();
    }
  });
});