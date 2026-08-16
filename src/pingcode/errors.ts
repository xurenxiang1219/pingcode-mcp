export type PingCodeErrorCode =
  | "NOT_CONFIGURED"
  | "AUTHENTICATION_FAILED"
  | "PERMISSION_DENIED"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "UPSTREAM_UNAVAILABLE"
  | "TIMEOUT"
  | "INVALID_RESPONSE"
  | "RESPONSE_TOO_LARGE"
  | "BAD_REQUEST";

export class PingCodeError extends Error {
  constructor(
    message: string,
    public readonly code: PingCodeErrorCode,
    public readonly options: {
      status?: number;
      retryable?: boolean;
      retryAfterSeconds?: number;
      requestId?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "PingCodeError";
  }

  get retryable(): boolean {
    return this.options.retryable ?? false;
  }
}
