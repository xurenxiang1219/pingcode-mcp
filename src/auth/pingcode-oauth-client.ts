import type { PingCodeCredentials } from "../config.js";
import type { Logger } from "../logger.js";
import { PingCodeError } from "../pingcode/errors.js";
import { userOAuthTokenSchema } from "../pingcode/schemas.js";
import { normalizeExpiry, type FetchLike } from "../pingcode/token-provider.js";

export interface PingCodeUserTokens {
  accessToken: string;
  refreshToken: string;
  expiresAtMs: number;
}

export class PingCodeOAuthClient {
  constructor(
    private readonly authorizationBaseUrl: string,
    private readonly apiBaseUrl: string,
    private readonly credentials: PingCodeCredentials,
    private readonly timeoutMs: number,
    private readonly logger: Logger,
    private readonly fetchImpl: FetchLike = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  createAuthorizationUrl(state: string): URL {
    const url = new URL("authorize", `${this.authorizationBaseUrl}/`);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.credentials.clientId);
    url.searchParams.set("state", state);
    return url;
  }

  async exchangeAuthorizationCode(code: string): Promise<PingCodeUserTokens> {
    const payload = await this.requestToken({
      grant_type: "authorization_code",
      client_id: this.credentials.clientId,
      client_secret: this.credentials.clientSecret,
      code,
    });
    if (!payload.refreshToken) {
      throw new PingCodeError("PingCode 使用者 Token 響應缺少 Refresh Token", "INVALID_RESPONSE");
    }
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken,
      expiresAtMs: payload.expiresAtMs,
    };
  }

  async refresh(refreshToken: string): Promise<PingCodeUserTokens> {
    const payload = await this.requestToken({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
    return {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? refreshToken,
      expiresAtMs: payload.expiresAtMs,
    };
  }

  private async requestToken(query: Record<string, string>): Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresAtMs: number;
  }> {
    const url = new URL("v1/auth/token", `${this.apiBaseUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

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
        timeout ? "取得 PingCode 使用者 Token 逾時" : "無法連線到 PingCode 認證服務",
        timeout ? "TIMEOUT" : "UPSTREAM_UNAVAILABLE",
        { retryable: true, cause: error },
      );
    }

    if (!response.ok) {
      this.logger.warn("請求 PingCode 使用者 Token 失敗", { status: response.status });
      throw new PingCodeError("PingCode 拒絕了使用者 OAuth 請求", "AUTHENTICATION_FAILED", {
        status: response.status,
      });
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (error) {
      throw new PingCodeError("PingCode 返回了無效的使用者 Token 響應", "INVALID_RESPONSE", {
        cause: error,
      });
    }
    const parsed = userOAuthTokenSchema.safeParse(body);
    if (!parsed.success) {
      throw new PingCodeError("PingCode 使用者 Token 響應不符合預期資料結構", "INVALID_RESPONSE", {
        cause: parsed.error,
      });
    }
    return {
      accessToken: parsed.data.access_token,
      ...(parsed.data.refresh_token ? { refreshToken: parsed.data.refresh_token } : {}),
      expiresAtMs: normalizeExpiry(parsed.data.expires_in, this.now()),
    };
  }
}

function isTimeoutError(error: unknown): boolean {
  return error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
}
