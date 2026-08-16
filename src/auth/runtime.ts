import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { CimdClientResolver } from "./cimd-client-resolver.js";
import { MemoryOAuthStore } from "./memory-store.js";
import { PingCodeOAuthClient } from "./pingcode-oauth-client.js";
import { PingCodeOAuthProvider } from "./pingcode-oauth-provider.js";
import { RedisOAuthStore } from "./redis-store.js";
import { EncryptedOAuthStore, type RawOAuthStore } from "./store.js";
import { TokenCipher } from "./token-cipher.js";

export interface UserOAuthRuntime {
  provider: PingCodeOAuthProvider;
  ping(): Promise<void>;
  close(): Promise<void>;
}

export async function createUserOAuthRuntime(
  config: AppConfig,
  logger: Logger,
): Promise<UserOAuthRuntime> {
  const credentials = config.pingcode.credentials;
  const publicBaseUrl = config.server.publicBaseUrl;
  const encryptionKey = config.oauth.encryptionKey;
  if (config.pingcode.authMode !== "user_oauth" || !credentials || !publicBaseUrl || !encryptionKey) {
    throw new Error("user_oauth 配置不完整，無法建立 OAuth Runtime");
  }

  let rawStore: RawOAuthStore;
  if (config.oauth.store === "redis") {
    if (!config.oauth.redisUrl) {
      throw new Error("尚未配置 MCP_OAUTH_REDIS_URL");
    }
    const redisStore = new RedisOAuthStore(config.oauth.redisUrl);
    await redisStore.connect();
    rawStore = redisStore;
  } else {
    rawStore = new MemoryOAuthStore();
  }

  const store = new EncryptedOAuthStore(rawStore, new TokenCipher(encryptionKey));
  await store.ping();
  const cimdClientResolver = config.oauth.cimdEnabled
    ? new CimdClientResolver({
        logger,
        allowedHosts: config.oauth.cimdAllowedHosts,
      })
    : undefined;
  const pingCodeClient = new PingCodeOAuthClient(
    config.pingcode.oauthBaseUrl,
    config.pingcode.apiBaseUrl,
    credentials,
    config.pingcode.requestTimeoutMs,
    logger,
  );
  const provider = new PingCodeOAuthProvider({
    store,
    pingCodeClient,
    publicBaseUrl,
    accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
    refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
    dcrClientTtlSeconds: config.oauth.dcrClientTtlSeconds,
    cimdClientResolver,
    logger,
  });
  logger.info("已啟用 PingCode 使用者 OAuth", {
    oauthStore: config.oauth.store,
    cimdEnabled: provider.supportsCimd,
    callbackPath: provider.callbackUrl.pathname,
  });

  return {
    provider,
    ping: () => store.ping(),
    close: () => store.close(),
  };
}
