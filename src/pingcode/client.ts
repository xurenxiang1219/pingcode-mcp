import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import { metrics } from "../observability/metrics.js";
import { PingCodeError } from "./errors.js";
import type { AccessTokenProvider } from "./access-token-provider.js";
import type { FetchLike } from "./token-provider.js";

export interface PingCodeClientLike {
  get(path: string, query?: Record<string, string | number | boolean | undefined>): Promise<unknown>;
}

export interface PingCodeClientRetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  random?: () => number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export class PingCodeClient implements PingCodeClientLike {
  private readonly maxRetries: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly random: () => number;
  private readonly now: () => number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly tokenProvider: AccessTokenProvider,
    private readonly timeoutMs: number,
    private readonly maxResponseBytes: number,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    retryOptions: PingCodeClientRetryOptions = {},
  ) {
    this.maxRetries = retryOptions.maxRetries ?? 2;
    this.baseDelayMs = retryOptions.baseDelayMs ?? 250;
    this.maxDelayMs = retryOptions.maxDelayMs ?? 2000;
    this.random = retryOptions.random ?? Math.random;
    this.now = retryOptions.now ?? Date.now;
    this.sleep = retryOptions.sleep ?? delay;
  }

  async get(path: string, query: Record<string, string | number | boolean | undefined> = {}): Promise<unknown> {
    if (!path.startsWith("/")) {
      throw new PingCodeError("PingCode API 路徑必須以 '/' 開頭", "BAD_REQUEST");
    }

    const url = new URL(path, `${this.apiBaseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }

    const requestId = randomUUID();
    let lastError: PingCodeError | null = null;
    let tokenRefreshAttempted = false;

    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      const accessToken = await this.tokenProvider.getAccessToken();
      let response: Response;
      const startedAt = this.now();

      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${accessToken}`,
            "User-Agent": "pingcode-mcp/0.1.0",
            "X-Request-ID": requestId,
          },
          signal: AbortSignal.timeout(this.timeoutMs),
        });
      } catch (error) {
        metrics.recordPingCodeRequest(undefined, this.now() - startedAt);
        const timeout = isTimeoutError(error);
        lastError = new PingCodeError(
          timeout ? "PingCode API 請求逾時" : "無法連線到 PingCode API",
          timeout ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
          { retryable: true, requestId, cause: error },
        );
        if (attempt < this.maxRetries) {
          await this.retry(requestId, path, attempt, lastError);
          continue;
        }
        throw lastError;
      }

      const durationMs = this.now() - startedAt;
      metrics.recordPingCodeRequest(response.status, durationMs);
      this.logger.debug("PingCode API 請求完成", {
        requestId,
        path,
        status: response.status,
        durationMs,
      });

      if (response.ok) {
        return this.parseJsonResponse(response, requestId);
      }

      if (response.status === 401 && !tokenRefreshAttempted && attempt < this.maxRetries) {
        this.tokenProvider.invalidate();
        tokenRefreshAttempted = true;
        metrics.recordPingCodeRetry();
        this.logger.warn("PingCode Access Token 失效，將刷新後重試", {
          requestId,
          path,
          attempt: attempt + 1,
        });
        continue;
      }

      const mapped = mapHttpError(response, requestId, this.now());
      if (mapped.retryable && attempt < this.maxRetries) {
        lastError = mapped;
        await this.retry(requestId, path, attempt, mapped);
        continue;
      }

      throw mapped;
    }

    throw lastError ?? new PingCodeError("PingCode API 請求失敗", "UPSTREAM_UNAVAILABLE", { requestId });
  }

  private async retry(
    requestId: string,
    path: string,
    attempt: number,
    error: PingCodeError,
  ): Promise<void> {
    const delayMs = this.retryDelayMs(attempt, error.options.retryAfterSeconds);
    metrics.recordPingCodeRetry();
    this.logger.warn("PingCode API 暫時失敗，將進行有限重試", {
      requestId,
      path,
      code: error.code,
      status: error.options.status,
      attempt: attempt + 1,
      nextAttempt: attempt + 2,
      delayMs,
    });
    await this.sleep(delayMs);
  }

  private retryDelayMs(attempt: number, retryAfterSeconds?: number): number {
    if (retryAfterSeconds !== undefined) {
      return Math.min(retryAfterSeconds * 1000, this.maxDelayMs);
    }
    const exponential = Math.min(this.baseDelayMs * 2 ** attempt, this.maxDelayMs);
    return Math.round(exponential * (0.5 + this.random() * 0.5));
  }

  private async parseJsonResponse(response: Response, requestId: string): Promise<unknown> {
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
      throw new PingCodeError("PingCode 響應超過設定的大小限制", "RESPONSE_TOO_LARGE", {
        requestId,
      });
    }

    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > this.maxResponseBytes) {
      throw new PingCodeError("PingCode 響應超過設定的大小限制", "RESPONSE_TOO_LARGE", {
        requestId,
      });
    }

    try {
      return JSON.parse(text) as unknown;
    } catch (error) {
      throw new PingCodeError("PingCode 返回了無效的 JSON", "INVALID_RESPONSE", {
        requestId,
        cause: error,
      });
    }
  }
}

function mapHttpError(response: Response, requestId: string, nowMs: number): PingCodeError {
  const retryAfterSeconds = parseRetryAfter(response.headers.get("retry-after"), nowMs);

  if (response.status === 401) {
    return new PingCodeError("PingCode 認證失敗", "AUTHENTICATION_FAILED", {
      status: response.status,
      requestId,
    });
  }
  if (response.status === 403) {
    return new PingCodeError("PingCode 應用無權存取此資源", "PERMISSION_DENIED", {
      status: response.status,
      requestId,
    });
  }
  if (response.status === 404) {
    return new PingCodeError("找不到請求的 PingCode 資源", "NOT_FOUND", {
      status: response.status,
      requestId,
    });
  }
  if (response.status === 429) {
    return new PingCodeError("PingCode API 請求頻率超過限制", "RATE_LIMITED", {
      status: response.status,
      requestId,
      retryable: true,
      ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    });
  }
  if (response.status >= 500) {
    return new PingCodeError("PingCode 服務暫時不可用", "UPSTREAM_UNAVAILABLE", {
      status: response.status,
      requestId,
      retryable: true,
    });
  }

  return new PingCodeError("PingCode 拒絕了 API 請求", "BAD_REQUEST", {
    status: response.status,
    requestId,
  });
}

function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) {
    return undefined;
  }

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds;
  }
  const retryAtMs = Date.parse(value);
  if (!Number.isFinite(retryAtMs)) {
    return undefined;
  }
  return Math.max(0, Math.ceil((retryAtMs - nowMs) / 1000));
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
