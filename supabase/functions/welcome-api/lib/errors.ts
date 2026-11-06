// Typed API errors. Every error the API returns has a stable code and HTTP status.

export type ErrorCode =
  | "INVALID_JSON"
  | "INVALID_REQUEST"
  | "VALIDATION_ERROR"
  | "UNKNOWN_ACTION"
  | "METHOD_NOT_ALLOWED"
  | "PAYLOAD_TOO_LARGE"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "MERCHANT_NOT_FOUND"
  | "PRODUCT_NOT_FOUND"
  | "PRODUCT_MERCHANT_MISMATCH"
  | "MERCHANT_NOT_PUBLISHED"
  | "PRODUCT_UNAVAILABLE"
  | "INTERNAL_ERROR";

export const ERROR_STATUS: Record<ErrorCode, number> = {
  INVALID_JSON: 400,
  INVALID_REQUEST: 400,
  VALIDATION_ERROR: 400,
  UNKNOWN_ACTION: 400,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  MERCHANT_NOT_FOUND: 404,
  PRODUCT_NOT_FOUND: 404,
  PRODUCT_MERCHANT_MISMATCH: 400,
  MERCHANT_NOT_PUBLISHED: 409,
  PRODUCT_UNAVAILABLE: 409,
  INTERNAL_ERROR: 500,
};

export class WelcomeError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "WelcomeError";
    this.code = code;
    this.status = ERROR_STATUS[code];
    this.details = details;
  }
}

export function isWelcomeError(err: unknown): err is WelcomeError {
  return err instanceof WelcomeError;
}
