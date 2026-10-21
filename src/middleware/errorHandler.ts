import type { Request, Response, NextFunction } from 'express';
import { isAppError, isSimulationFailedError, isApiError, isErrorCode } from '../errors/index.js';
import { logger } from '../logger.js';
import type { ValidationErrorDetail } from './validate.js';
import { ValidationError } from './validate.js';
import type { ApiEnvelope } from '../types/ResponseEnvelope.js';
import { normalizeError } from '../errors/errorEnvelopePolicy.js';
import { buildErrorEnvelope } from './envelope.js';

const isProduction = process.env.NODE_ENV === "production";

function extractValidationDetails(err: unknown): ValidationErrorDetail[] | undefined {
  if (err instanceof ValidationError) {
    return err.details;
  }

  if (
    !!err &&
    typeof err === "object" &&
    Array.isArray((err as { details?: unknown[] }).details)
  ) {
    return (err as { details: ValidationErrorDetail[] }).details;
  }

  return undefined;
}

function mapFrameworkError(err: unknown): { statusCode: number; code: string; message: string } | null {
  // Handle express.json() parse errors (entity.parse.failed)
  if (err instanceof SyntaxError && 'status' in err && err.status === 400 && 'type' in err) {
    const type = (err as Record<string, unknown>).type;
    if (type === 'entity.parse.failed') {
      return { statusCode: 400, code: 'MALFORMED_JSON', message: 'Request body is not valid JSON' };
    }
    if (type === 'entity.too.large') {
      return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
    }
    if (type === 'encoding.unsupported') {
      return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' };
    }
    if (type === 'charset.unsupported') {
      return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported charset' };
    }
  }

  // Handle express.urlencoded() errors
  if (err instanceof Error && 'status' in err && typeof (err as Record<string, unknown>).status === 'number') {
    const status = (err as Record<string, unknown>).status as number;
    const type = (err as Record<string, unknown>).type as string | undefined;
    
    if (status === 413 || type === 'entity.too.large') {
      return { statusCode: 413, code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' };
    }
    if (type === 'encoding.unsupported' || type === 'charset.unsupported') {
      return { statusCode: 415, code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Unsupported media type' };
    }
  }

  return null;
}

/**
 * Terminate a response whose headers were already flushed.
 *
 * Once headers are out we can no longer send a JSON error envelope: writing one
 * would corrupt the in-flight body, and simply returning leaves the client with
 * a truncated stream that looks complete (or hangs until its own timeout) while
 * the socket leaks. Destroying the response makes the client observe an aborted
 * stream instead.
 *
 * - No-op if the response already ended cleanly or was already destroyed
 *   (e.g. the client disconnected first), so we never double-destroy or kill a
 *   keep-alive socket that completed successfully.
 * - Never throws: an error handler must not raise a second error.
 */
function terminateAfterHeadersSent(res: Response<ApiEnvelope>, err: unknown, requestId: string): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }

  try {
    res.destroy(err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Response aborted after headers were sent'));
  } catch (destroyErr) {
    logger.warn('[errorHandler] failed to destroy response after headers sent', {
      requestId,
      message: destroyErr instanceof Error ? destroyErr.message : String(destroyErr),
    });
  }
}

/**
 * Global error-handling middleware (4-arg form).
 * - Catches errors thrown in routes/services
 * - Maps known AppError subclasses to HTTP status codes
 * - Returns RFC 7807 problem+json format: { type, title, status, code, detail, instance, errors }
 * - Never sends stack traces to the client in production
 * - Logs full error server-side (exactly once, with requestId)
 * - If headers were already sent (mid-stream failure), the error is logged and
 *   the response/socket is destroyed so the client sees a terminated stream
 */
export function errorHandler(
  err: unknown,
  req: Request,
  res: Response<ApiEnvelope>,
  _next: NextFunction,
): void {
  const requestId = req.id || "unknown";
  const instance = req.originalUrl || req.url;

  // Check for ApiError (RFC 7807 format)
  if (isApiError(err)) {
    const statusCode = err.status;
    const problem = err.toProblemDetails(instance);
    
    // Set Content-Type for problem+json
    if (!res.headersSent) {
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/problem+json');
      }
      res.status(statusCode).json(problem);
    }

    const logData = {
      requestId,
      statusCode,
      ...(res.headersSent ? { headersSent: true } : {}),
      message: err.detail ?? err.title,
      ...(isProduction ? {} : { err }),
    };

    if (isProduction) {
      logger.error("[errorHandler]", logData, err.stack);
    } else {
      logger.error("[errorHandler]", logData);
    }

    if (res.headersSent) {
      terminateAfterHeadersSent(res, err, requestId);
    }
    return;
  }

  // Check for framework errors (express.json, express.urlencoded, etc.)
  const frameworkError = mapFrameworkError(err);
  if (frameworkError) {
    const { statusCode, code, message } = frameworkError;
    const problem = {
      type: `https://callora-backend.vercel.app/errors/${code.toLowerCase()}`,
      title: getDefaultTitle(statusCode),
      status: statusCode,
      code,
      detail: message,
      instance,
      // Legacy field for backward compatibility
      error: getDefaultTitle(statusCode),
    };

    if (!res.headersSent) {
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/problem+json');
      }
      res.status(statusCode).json(problem);
    }

    const logData = {
      requestId,
      statusCode,
      ...(res.headersSent ? { headersSent: true } : {}),
      message,
      ...(isProduction ? {} : { err }),
    };

    if (isProduction) {
      logger.error("[errorHandler]", logData, err instanceof Error ? err.stack : String(err));
    } else {
      logger.error("[errorHandler]", logData);
    }

    if (res.headersSent) {
      terminateAfterHeadersSent(res, err, requestId);
    }
    return;
  }

  // Check for ValidationError (has validation details)
  if (err instanceof ValidationError) {
    const statusCode = err.statusCode;
    const title = getDefaultTitle(statusCode);
    const problem = {
      type: `https://callora-backend.vercel.app/errors/${err.code?.toLowerCase() ?? 'bad_request'}`,
      title,
      status: statusCode,
      code: err.code ?? 'VALIDATION_ERROR',
      detail: err.message,
      instance,
      errors: err.details,
      // Legacy field for backward compatibility
      error: title,
    };

    if (!res.headersSent) {
      if (typeof res.setHeader === 'function') {
        res.setHeader('Content-Type', 'application/problem+json');
      }
      res.status(statusCode).json(problem);
    }

    const logData = {
      requestId,
      statusCode,
      ...(res.headersSent ? { headersSent: true } : {}),
      message: err.message,
      ...(isProduction ? {} : { err }),
    };

    if (isProduction) {
      logger.error("[errorHandler]", logData, err.stack);
    } else {
      logger.error("[errorHandler]", logData);
    }

    if (res.headersSent) {
      terminateAfterHeadersSent(res, err, requestId);
    }
    return;
  }

  // Check for errors with a known error code (e.g., ROUTE_NOT_FOUND thrown with err.code)
  if (err instanceof Error && 'code' in err && typeof (err as Record<string, unknown>).code === 'string') {
    const errCode = (err as Record<string, unknown>).code as string;
    if (isErrorCode(errCode)) {
      const statusCode = 'status' in err && typeof (err as Record<string, unknown>).status === 'number'
        ? (err as Record<string, unknown>).status as number
        : getStatusForCode(errCode);
      const title = getDefaultTitle(statusCode);
      const problem = {
        type: `https://callora-backend.vercel.app/errors/${errCode.toLowerCase()}`,
        title,
        status: statusCode,
        code: errCode,
        detail: err.message,
        instance,
        // Legacy field for backward compatibility
        error: title,
      };

      if (!res.headersSent) {
        if (typeof res.setHeader === 'function') {
          res.setHeader('Content-Type', 'application/problem+json');
        }
        res.status(statusCode).json(problem);
      }

      const logData = {
        requestId,
        statusCode,
        ...(res.headersSent ? { headersSent: true } : {}),
        message: err.message,
        ...(isProduction ? {} : { err }),
      };

      if (isProduction) {
        logger.error("[errorHandler]", logData, err.stack);
      } else {
        logger.error("[errorHandler]", logData);
      }

      if (res.headersSent) {
        terminateAfterHeadersSent(res, err, requestId);
      }
      return;
    }
  }

  // Handle legacy AppError classes
  const statusCarrier = err !== null && typeof err === 'object' ? err as Record<string, unknown> : undefined;
  const statusCode = isAppError(err)
    ? err.statusCode
    : typeof statusCarrier?.status === "number"
      ? statusCarrier.status
      : 500;

  const rawMessage =
    statusCode === 413
      ? "Request body too large"
      : err instanceof Error
        ? err.message
        : "Internal server error";

  // Simulation details are only read off the SimulationFailedError this
  // codebase throws; they were redacted in its constructor and are re-checked
  // against the whitelist by normalizeError/buildErrorEnvelope.
  const simulationDetails = isSimulationFailedError(err) ? err.simulationDetails : undefined;
  const normalized = normalizeError({
    statusCode,
    code: isAppError(err) ? err.code : undefined,
    message: rawMessage,
    details: extractValidationDetails(err),
    simulationDetails,
    trusted: isAppError(err),
    development: process.env.NODE_ENV === 'development',
  });

  // Convert to problem+json format
  const code = normalized.code;
  const title = getDefaultTitle(statusCode);
  const problem = {
    type: `https://callora-backend.vercel.app/errors/${code.toLowerCase()}`,
    title,
    status: statusCode,
    code,
    detail: normalized.message,
    instance,
    ...(normalized.details && normalized.details.length > 0 ? { errors: normalized.details } : {}),
    // Legacy field for backward compatibility
    error: title,
  };

  if (!res.headersSent) {
    if (typeof res.setHeader === 'function') {
      res.setHeader('Content-Type', 'application/problem+json');
    }
    res.status(statusCode).json(problem);
  }

  const logData = {
    requestId,
    statusCode,
    ...(res.headersSent ? { headersSent: true } : {}),
    message: rawMessage,
    ...(isProduction ? {} : { err }),
  };

  if (isProduction) {
    logger.error(
      "[errorHandler]",
      logData,
      err instanceof Error ? err.stack : String(err),
    );
  } else {
    logger.error("[errorHandler]", logData);
  }

  // Log first, then terminate, so the error is recorded exactly once even if
  // teardown fails.
  if (res.headersSent) {
    terminateAfterHeadersSent(res, err, requestId);
  }
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

function getStatusForCode(code: string): number {
  const statusMap: Record<string, number> = {
    BAD_REQUEST: 400,
    UNAUTHORIZED: 401,
    FORBIDDEN: 403,
    NOT_FOUND: 404,
    PAYMENT_REQUIRED: 402,
    TOO_MANY_REQUESTS: 429,
    CONFLICT: 409,
    INTERNAL_SERVER_ERROR: 500,
    BAD_GATEWAY: 502,
    SERVICE_UNAVAILABLE: 503,
    GATEWAY_TIMEOUT: 504,
    VALIDATION_ERROR: 400,
    INVALID_BODY: 400,
    INVALID_QUERY: 400,
    INVALID_PARAMS: 400,
    INVALID_VALUE: 400,
    GATEWAY_AUTH_CONTEXT_MISSING: 500,
    UPSTREAM_TARGET_BLOCKED: 502,
    INSUFFICIENT_BALANCE: 402,
    SOROBAN_RPC_TIMEOUT: 504,
    SOROBAN_RPC_ERROR: 502,
    BILLING_DEDUCTION_FAILED: 500,
    RECONCILIATION_REQUIRED: 409,
    BILLING_REQUEST_NOT_FOUND: 404,
    FORECAST_DATA_UNAVAILABLE: 503,
    DEVELOPER_NOT_FOUND: 404,
    API_ACCESS_FORBIDDEN: 403,
    API_KEY_NOT_FOUND: 404,
    API_KEY_FORBIDDEN: 403,
    MISSING_REFRESH_TOKEN: 401,
    INVALID_REFRESH_TOKEN: 401,
    REVOKED_TOKEN: 401,
    EXPIRED_TOKEN: 401,
    REFRESH_FAILED: 500,
    REVOKE_FAILED: 500,
    NOT_AUTHENTICATED: 401,
    TOKEN_INFO_FAILED: 500,
    VAULT_NOT_FOUND: 404,
    VAULT_BALANCE_RETRIEVAL_FAILED: 500,
    MISSING_AMOUNT: 400,
    INVALID_AMOUNT_TYPE: 400,
    INVALID_AMOUNT_FORMAT: 400,
    INVALID_NETWORK: 400,
    NETWORK_MISMATCH: 400,
    INVALID_SOURCE_ACCOUNT: 400,
    INVALID_TRANSACTION_INPUT: 400,
    SOURCE_ACCOUNT_NOT_FOUND: 404,
    INVALID_CONTRACT_ID: 400,
    NETWORK_UNAVAILABLE: 503,
    TRANSACTION_BUILD_FAILED: 500,
    INTERNAL_ERROR: 500,
    INVALID_WEBHOOK_REGISTRATION: 400,
    INVALID_WEBHOOK_EVENT_TYPES: 400,
    WEBHOOK_NOT_FOUND: 404,
    INVALID_WEBHOOK_URL: 400,
    WEBHOOK_URL_VALIDATION_FAILED: 400,
    MISSING_WEBHOOK_SIGNATURE_HEADERS: 400,
    INVALID_WEBHOOK_TIMESTAMP: 400,
    WEBHOOK_TIMESTAMP_OUT_OF_WINDOW: 400,
    MALFORMED_WEBHOOK_SIGNATURE: 400,
    INVALID_WEBHOOK_SIGNATURE: 401,
    MALFORMED_WEBHOOK_NONCE: 400,
    WEBHOOK_NONCE_REPLAYED: 409,
    INVALID_DELIVERY_ID: 400,
    INVALID_RETRY_POLICY: 400,
    DLQ_ENTRY_NOT_FOUND: 404,
    INVALID_IP_FORMAT: 400,
    IP_NOT_ALLOWED: 403,
    DATABASE_NOT_AVAILABLE: 503,
    IDEMPOTENCY_CONFLICT: 409,
    IDEMPOTENCY_RESPONSE_TOO_LARGE: 413,
    IDEMPOTENCY_IN_PROGRESS: 409,
    SIMULATION_FAILED: 502,
    INVALID_AUTH_HEADER: 401,
    MISSING_TOKEN: 401,
    INVALID_TOKEN: 401,
    MISSING_CLAIMS: 401,
    TOKEN_EXPIRED: 401,
    TOKEN_NOT_ACTIVE: 401,
    QUOTA_REQUEST_NOT_FOUND: 404,
    QUOTA_REQUEST_ALREADY_RESOLVED: 409,
    INVALID_QUOTA_REQUEST: 400,
    REQUEST_TIMEOUT: 408,
    REQUEST_BODY_TOO_LARGE: 413,
    UNSUPPORTED_MEDIA_TYPE: 415,
    UNPROCESSABLE_ENTITY: 422,
    USAGE_AGGREGATE_NOT_FOUND: 404,
    INVALID_EXPORT_SCHEDULE: 400,
    EXPORT_SCHEDULE_NOT_FOUND: 404,
    MISSING_AUTH_FIELDS: 401,
    AUTH_NOT_IMPLEMENTED: 501,
    COMPONENT_NOT_CONFIGURED: 503,
    INVALID_ENTRY_ID: 400,
    AUDIT_ENTRY_NOT_FOUND: 404,
    AUDIT_ACTION_NOT_REPLAYABLE: 400,
    AUDIT_DETAILS_INCOMPLETE: 400,
    LOG_ENTRY_NOT_FOUND: 404,
    BULK_QUOTA_UPDATE_FAILED: 500,
    STALE_FORWARDED_IDENTITY: 401,
    REPLAYED_FORWARDED_IDENTITY: 409,
    MALFORMED_JSON: 400,
    PAYLOAD_TOO_LARGE: 413,
    ROUTE_NOT_FOUND: 404,
  };
  
  return statusMap[code] ?? 500;
}