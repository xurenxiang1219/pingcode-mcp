import { enterpriseTokenSchema } from "./schemas.js";
import { PingCodeError } from "./errors.js";
import type { Logger } from "../logger.js";
import type { PingCodeCredentials } from "../config.js";
import type { AccessTokenProvider } from "./access-token-provider.js";

export type FetchLike = typeof fetch;

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
}

export class EnterpriseTokenProvider implements AccessTokenProvider {
  private cachedToken: CachedToken | null = null;
  private refreshPromise: Promise<string> | null = null;

  constructor(
    private readonly apiBaseUrl: string,
    private readonly credentials: PingCodeCredentials,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAtMs > this.now() + 60_000) {
      return this.cachedToken.accessToken;
    }

    if (!this.refreshPromise) {
      this.refreshPromise = this.fetchToken().finally(() => {
        this.refreshPromise = null;
      });
    }

    return this.refreshPromise;
  }

  invalidate(): void {
    this.cachedToken = null;
  }

  private async fetchToken(): Promise<string> {
    const url = new URL("v1/auth/token", `${this.apiBaseUrl}/`);
    url.searchParams.set("grant_type", "client_credentials");
    url.searchParams.set("client_id", this.credentials.clientId);
    url.searchParams.set("client_secret", this.credentials.clientSecret);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const timeout = isTimeoutError(error);
      throw new PingCodeError(
        timeout ? "取得 PingCode 企業 Token 逾時" : "無法連線到 PingCode 認證服務",
        timeout ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        { retryable: true, cause: error },
      );
    }

    if (!response.ok) {
      this.logger.warn("請求 PingCode 企業 Token 失敗", { status: response.status });
      throw new PingCodeError("PingCode 拒絕了企業應用憑據", "AUTHENTICATION_FAILED", {
        status: response.status,
      });
    }

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      throw new PingCodeError("PingCode 返回了無效的 Token 響應", "INVALID_RESPONSE", { cause: error });
    }

    const parsed = enterpriseTokenSchema.safeParse(payload);
    if (!parsed.success) {
      throw new PingCodeError("PingCode Token 響應不符合預期資料結構", "INVALID_RESPONSE", {
        cause: parsed.error,
      });
    }

    this.cachedToken = {
      accessToken: parsed.data.access_token,
      expiresAtMs: normalizeExpiry(parsed.data.expires_in, this.now()),
    };
    this.logger.info("已取得 PingCode 企業 Token", {
      expiresAt: new Date(this.cachedToken.expiresAtMs).toISOString(),
    });

    return this.cachedToken.accessToken;
  }
}

export function normalizeExpiry(value: number | string | undefined, nowMs: number): number {
  const parsed = typeof value === "string" ? Number(value) : value;
  const nowSeconds = Math.floor(nowMs / 1000);

  if (parsed && Number.isFinite(parsed)) {
    if (parsed > nowSeconds && parsed < nowSeconds + 10 * 365 * 24 * 60 * 60) {
      return parsed * 1000;
    }

    if (parsed > 0 && parsed <= 10 * 365 * 24 * 60 * 60) {
      return nowMs + parsed * 1000;
    }
  }

  // PingCode 文件說明 Token 有效期為 30 天；未返回有效期限時採用較保守的 25 天。
  return nowMs + 25 * 24 * 60 * 60 * 1000;
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
