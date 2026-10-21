import { ProblemDetails, ValidationErrorDetail, buildTypeUri, getDefaultTitle, getDefaultDescription, ERROR_TYPE_BASE_URI } from './problem.js';
import { isErrorCode, ErrorCode } from './codes.js';

export interface ApiErrorOptions {
  detail?: string;
  errors?: ValidationErrorDetail[];
  extra?: Record<string, unknown>;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly title: string;
  public readonly type: string;
  public readonly detail?: string;
  public readonly errors?: ValidationErrorDetail[];
  public readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    code: string,
    title: string,
    options: ApiErrorOptions = {}
  ) {
    super(options.detail ?? title);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.title = title;
    this.type = buildTypeUri(code);
    this.detail = options.detail;
    this.errors = options.errors;
    this.extra = options.extra;
    
    Object.setPrototypeOf(this, ApiError.prototype);
  }

  toProblemDetails(instance?: string): ProblemDetails {
    const problem: ProblemDetails = {
      type: this.type,
      title: this.title,
      status: this.status,
      code: this.code,
      instance,
    };

    if (this.detail) {
      problem.detail = this.detail;
    }

    if (this.errors && this.errors.length > 0) {
      problem.errors = this.errors;
    }

    // Legacy field for backward compatibility - will be removed in next release
    problem.error = this.title;

    return problem;
  }
}

export function badRequest(code: string, detail?: string, errors?: ValidationErrorDetail[]): ApiError {
  return new ApiError(400, code, getDefaultTitle(400), { detail, errors });
}

export function unauthorized(code: string, detail?: string): ApiError {
  return new ApiError(401, code, getDefaultTitle(401), { detail });
}

export function forbidden(code: string, detail?: string): ApiError {
  return new ApiError(403, code, getDefaultTitle(403), { detail });
}

export function notFound(code: string, detail?: string): ApiError {
  return new ApiError(404, code, getDefaultTitle(404), { detail });
}

export function paymentRequired(code: string, detail?: string): ApiError {
  return new ApiError(402, code, getDefaultTitle(402), { detail });
}

export function conflict(code: string, detail?: string): ApiError {
  return new ApiError(409, code, getDefaultTitle(409), { detail });
}

export function tooManyRequests(code: string, detail?: string): ApiError {
  return new ApiError(429, code, getDefaultTitle(429), { detail });
}

export function unprocessableEntity(code: string, detail?: string, errors?: ValidationErrorDetail[]): ApiError {
  return new ApiError(422, code, getDefaultTitle(422), { detail, errors });
}

export function internalServerError(code: string, detail?: string): ApiError {
  return new ApiError(500, code, getDefaultTitle(500), { detail });
}

export function badGateway(code: string, detail?: string): ApiError {
  return new ApiError(502, code, getDefaultTitle(502), { detail });
}

export function serviceUnavailable(code: string, detail?: string): ApiError {
  return new ApiError(503, code, getDefaultTitle(503), { detail });
}

export function gatewayTimeout(code: string, detail?: string): ApiError {
  return new ApiError(504, code, getDefaultTitle(504), { detail });
}

export function requestTimeout(code: string, detail?: string): ApiError {
  return new ApiError(408, code, getDefaultTitle(408), { detail });
}

export function payloadTooLarge(code: string, detail?: string): ApiError {
  return new ApiError(413, code, getDefaultTitle(413), { detail });
}

export function unsupportedMediaType(code: string, detail?: string): ApiError {
  return new ApiError(415, code, getDefaultTitle(415), { detail });
}

export function malformedJson(detail?: string): ApiError {
  return new ApiError(400, 'MALFORMED_JSON', getDefaultTitle(400), { detail: detail ?? 'Request body is not valid JSON' });
}

export function validationFailed(errors: ValidationErrorDetail[], detail?: string): ApiError {
  return new ApiError(400, 'VALIDATION_FAILED', getDefaultTitle(400), { 
    detail: detail ?? 'Request validation failed',
    errors 
  });
}

export function invalidBody(detail?: string): ApiError {
  return new ApiError(400, 'INVALID_BODY', getDefaultTitle(400), { detail: detail ?? 'Request body is invalid or malformed' });
}

export function invalidQuery(detail?: string): ApiError {
  return new ApiError(400, 'INVALID_QUERY', getDefaultTitle(400), { detail: detail ?? 'Query parameters are invalid' });
}

export function invalidParams(detail?: string): ApiError {
  return new ApiError(400, 'INVALID_PARAMS', getDefaultTitle(400), { detail: detail ?? 'URL parameters are invalid' });
}

export function invalidValue(field: string, message: string, code: string, detail?: string): ApiError {
  return new ApiError(400, 'INVALID_VALUE', getDefaultTitle(400), { 
    detail: detail ?? `Field '${field}' is invalid`,
    errors: [{ field, message, code }]
  });
}

export function routeNotFound(path: string): ApiError {
  return new ApiError(404, 'ROUTE_NOT_FOUND', getDefaultTitle(404), { detail: `Route ${path} not found` });
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}

export function createApiErrorFromCode(code: string, detail?: string, errors?: ValidationErrorDetail[]): ApiError {
  const status = getStatusForCode(code);
  const title = getDefaultTitle(status);
  return new ApiError(status, code, title, { detail: detail ?? getDefaultDescription(code), errors });
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
  };
  
  return statusMap[code] ?? 500;
}

export function getErrorCatalog(): ErrorCatalogEntry[] {
  const codes = Object.values(ErrorCode);
  return codes.map(code => ({
    code,
    title: getDefaultTitle(getStatusForCode(code)),
    status: getStatusForCode(code),
    description: getDefaultDescription(code),
    type: buildTypeUri(code),
  }));
}

export function getErrorCatalogEntry(code: string): ErrorCatalogEntry | undefined {
  if (!isErrorCode(code)) {
    return undefined;
  }
  const status = getStatusForCode(code);
  return {
    code,
    title: getDefaultTitle(status),
    status,
    description: getDefaultDescription(code),
    type: buildTypeUri(code),
  };
}