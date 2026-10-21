import type { Request, Response, NextFunction } from 'express';
import type { ValidationErrorDetail } from './validate.js';
import { publicCodeForStatus } from '../errors/errorEnvelopePolicy.js';

export interface OpenApiError extends Error {
  status?: number;
  statusCode?: number;
  errors?: unknown[];
}

export function formatOpenApiField(e: unknown, index: number): string {
  if (typeof e !== 'object' || e === null) {
    return `body.${index}`;
  }

  const errObj = e as {
    path?: string;
    location?: string;
    params?: { missingProperty?: string };
  };

  let p = (typeof errObj.path === 'string' ? errObj.path : '').trim();
  p = p.replace(/^request[./]/, '');

  const segments = p
    .split(/[./]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  if (
    errObj.params?.missingProperty &&
    segments[segments.length - 1] !== errObj.params.missingProperty
  ) {
    segments.push(errObj.params.missingProperty);
  }

  if (errObj.location && segments[0] !== errObj.location) {
    segments.unshift(errObj.location);
  }

  if (segments.length === 0) {
    return errObj.location || 'body';
  }

  return segments.reduce((formatted, segment) => {
    if (/^\d+$/.test(segment)) {
      return `${formatted}[${segment}]`;
    }
    return formatted ? `${formatted}.${segment}` : segment;
  }, '');
}

export function formatOpenApiCode(e: unknown, field: string): string {
  if (typeof e === 'object' && e !== null) {
    const errObj = e as { code?: string; keyword?: string; errorCode?: string };
    if (typeof errObj.code === 'string' && errObj.code.trim()) {
      return errObj.code.trim().toUpperCase();
    }
    if (typeof errObj.keyword === 'string' && errObj.keyword.trim()) {
      return errObj.keyword.trim().toUpperCase();
    }
    if (typeof errObj.errorCode === 'string' && errObj.errorCode.trim()) {
      const first = errObj.errorCode.trim().split('.')[0];
      if (first) return first.toUpperCase();
    }
  }

  if (field.startsWith('query')) return 'INVALID_QUERY';
  if (field.startsWith('params')) return 'INVALID_PARAMS';
  return 'INVALID_BODY';
}

function getDefaultTitle(status: number): string {
  const titles: Record<number, string> = {
    400: 'Bad Request',
    401: 'Unauthorized',
    402: 'Payment Required',
    403: 'Forbidden',
    404: 'Not Found',
    408: 'Request Timeout',
    409: 'Conflict',
    413: 'Payload Too Large',
    415: 'Unsupported Media Type',
    422: 'Unprocessable Entity',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
  };
  return titles[status] ?? 'Error';
}

export function openApiErrorHandler(
  err: OpenApiError,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const status = typeof err.status === 'number' ? err.status : err.statusCode;
  if (!status) {
    return next(err);
  }

  const requestId = req.id || 'unknown';
  const instance = req.originalUrl || req.url;
  const details: ValidationErrorDetail[] | undefined =
    Array.isArray(err.errors) && err.errors.length > 0
      ? err.errors.map((e, i) => {
          const field = formatOpenApiField(e, i);
          const message =
            typeof e === 'object' && e !== null && 'message' in e
              ? String((e as { message: unknown }).message)
              : String(e);
          const code = formatOpenApiCode(e, field);
          return { field, message, code };
        })
      : undefined;

  const code = publicCodeForStatus(status);
  const title = getDefaultTitle(status);
  const problem = {
    type: `https://callora-backend.vercel.app/errors/${code.toLowerCase()}`,
    title,
    status,
    code,
    detail: err.message,
    instance,
    ...(details && details.length > 0 ? { errors: details } : {}),
    // Legacy field for backward compatibility
    error: title,
  };

  if (typeof res.setHeader === 'function') {
    res.setHeader('Content-Type', 'application/problem+json');
  }
  res.status(status).json(problem);
}