import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import { PingCodeClient } from "./pingcode/client.js";
import { PingCodeError } from "./pingcode/errors.js";
import { EnterpriseTokenProvider } from "./pingcode/token-provider.js";
import type { AccessTokenProvider } from "./pingcode/access-token-provider.js";
import { WikiRequirementSource } from "./sources/wiki-source.js";

export interface Services {
  isConfigured(): boolean;
  getWikiSource(): WikiRequirementSource;
}

export function createServices(
  config: AppConfig,
  logger: Logger,
  providedTokenProvider?: AccessTokenProvider,
): Services {
  let wikiSource: WikiRequirementSource | null = null;

  return {
    isConfigured: () => providedTokenProvider !== undefined || config.pingcode.credentials !== null,
    getWikiSource: () => {
      if (!providedTokenProvider && config.pingcode.authMode === "user_oauth") {
        throw new PingCodeError(
          "此請求尚未完成 PingCode 使用者 OAuth 登入。",
          "AUTHENTICATION_FAILED",
        );
      }

      if (!providedTokenProvider && !config.pingcode.credentials) {
        throw new PingCodeError(
          "尚未配置 PingCode 憑據，請設定 PINGCODE_CLIENT_ID 和 PINGCODE_CLIENT_SECRET。",
          "NOT_CONFIGURED",
        );
      }

      if (!wikiSource) {
        const tokenProvider =
          providedTokenProvider ??
          new EnterpriseTokenProvider(
            config.pingcode.apiBaseUrl,
            config.pingcode.credentials!,
            config.pingcode.requestTimeoutMs,
            logger,
          );
        const client = new PingCodeClient(
          config.pingcode.apiBaseUrl,
          tokenProvider,
          config.pingcode.requestTimeoutMs,
          config.pingcode.maxResponseBytes,
          logger,
          undefined,
          {
            maxRetries: config.pingcode.maxRetries,
            baseDelayMs: config.pingcode.retryBaseDelayMs,
            maxDelayMs: config.pingcode.retryMaxDelayMs,
          },
        );
        wikiSource = new WikiRequirementSource(client);
      }

      return wikiSource;
    },
  };
}
