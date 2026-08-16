import { z } from "zod";

const optionalString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const booleanString = z
  .enum(["true", "false"])
  .default("false")
  .transform((value) => value === "true");

const trueBooleanString = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const envSchema = z
  .object({
    PINGCODE_API_BASE_URL: z.url().default("https://open.pingcode.com"),
    PINGCODE_OAUTH_BASE_URL: z.url().default("https://open.pingcode.com/oauth2"),
    PINGCODE_AUTH_MODE: z.enum(["enterprise", "user_oauth"]).default("enterprise"),
    PINGCODE_CLIENT_ID: optionalString,
    PINGCODE_CLIENT_SECRET: optionalString,
    PINGCODE_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(10000),
    PINGCODE_MAX_RESPONSE_BYTES: z.coerce
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
    PINGCODE_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
    PINGCODE_RETRY_BASE_DELAY_MS: z.coerce.number().int().min(0).max(10000).default(250),
    PINGCODE_RETRY_MAX_DELAY_MS: z.coerce.number().int().min(0).max(30000).default(2000),
    MCP_HOST: z.string().trim().min(1).default("127.0.0.1"),
    MCP_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    MCP_ALLOW_REMOTE: booleanString,
    MCP_ALLOWED_HOSTS: optionalString,
    MCP_PUBLIC_BASE_URL: optionalUrl,
    MCP_OAUTH_STORE: z.enum(["memory", "redis"]).default("memory"),
    MCP_OAUTH_REDIS_URL: optionalString,
    MCP_OAUTH_ENCRYPTION_KEY: optionalString,
    MCP_OAUTH_CIMD_ENABLED: trueBooleanString,
    MCP_OAUTH_CIMD_ALLOWED_HOSTS: optionalString,
    MCP_OAUTH_DCR_CLIENT_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(24 * 60 * 60)
      .max(2 * 365 * 24 * 60 * 60)
      .default(365 * 24 * 60 * 60),
    MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(300).max(86400).default(3600),
    MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS: z.coerce
      .number()
      .int()
      .min(3600)
      .max(90 * 24 * 60 * 60)
      .default(30 * 24 * 60 * 60),
    MCP_METRICS_ENABLED: booleanString,
    MCP_METRICS_BEARER_TOKEN: optionalString,
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .superRefine((value, context) => {
    const hasClientId = value.PINGCODE_CLIENT_ID !== undefined;
    const hasClientSecret = value.PINGCODE_CLIENT_SECRET !== undefined;

    if (hasClientId !== hasClientSecret) {
      context.addIssue({
        code: "custom",
        message: "PINGCODE_CLIENT_ID 和 PINGCODE_CLIENT_SECRET 必須同時配置",
        path: hasClientId ? ["PINGCODE_CLIENT_SECRET"] : ["PINGCODE_CLIENT_ID"],
      });
    }

    if (value.PINGCODE_RETRY_MAX_DELAY_MS < value.PINGCODE_RETRY_BASE_DELAY_MS) {
      context.addIssue({
        code: "custom",
        message: "PINGCODE_RETRY_MAX_DELAY_MS 不得小於 PINGCODE_RETRY_BASE_DELAY_MS",
        path: ["PINGCODE_RETRY_MAX_DELAY_MS"],
      });
    }

    if (
      value.MCP_METRICS_ENABLED &&
      (!value.MCP_METRICS_BEARER_TOKEN || value.MCP_METRICS_BEARER_TOKEN.length < 32)
    ) {
      context.addIssue({
        code: "custom",
        message: "啟用 Metrics 時必須配置至少 32 字元的 MCP_METRICS_BEARER_TOKEN",
        path: ["MCP_METRICS_BEARER_TOKEN"],
      });
    }

    if (!isLoopbackHost(value.MCP_HOST) && !value.MCP_ALLOW_REMOTE) {
      context.addIssue({
        code: "custom",
        message: "將 MCP Server 綁定到非本機位址前，必須設定 MCP_ALLOW_REMOTE=true",
        path: ["MCP_ALLOW_REMOTE"],
      });
    }

    if (value.PINGCODE_AUTH_MODE === "user_oauth") {
      if (!hasClientId || !hasClientSecret) {
        context.addIssue({
          code: "custom",
          message: "user_oauth 模式必須配置 PINGCODE_CLIENT_ID 和 PINGCODE_CLIENT_SECRET",
          path: ["PINGCODE_CLIENT_ID"],
        });
      }
      if (!value.MCP_PUBLIC_BASE_URL) {
        context.addIssue({
          code: "custom",
          message: "user_oauth 模式必須配置 MCP_PUBLIC_BASE_URL",
          path: ["MCP_PUBLIC_BASE_URL"],
        });
      }
      if (!value.MCP_OAUTH_ENCRYPTION_KEY) {
        context.addIssue({
          code: "custom",
          message: "user_oauth 模式必須配置 MCP_OAUTH_ENCRYPTION_KEY",
          path: ["MCP_OAUTH_ENCRYPTION_KEY"],
        });
      } else if (!isValidEncryptionKey(value.MCP_OAUTH_ENCRYPTION_KEY)) {
        context.addIssue({
          code: "custom",
          message: "MCP_OAUTH_ENCRYPTION_KEY 必須是 Base64 編碼的 32-byte 金鑰",
          path: ["MCP_OAUTH_ENCRYPTION_KEY"],
        });
      }
      if (value.MCP_OAUTH_STORE === "redis" && !value.MCP_OAUTH_REDIS_URL) {
        context.addIssue({
          code: "custom",
          message: "Redis OAuth 儲存必須配置 MCP_OAUTH_REDIS_URL",
          path: ["MCP_OAUTH_REDIS_URL"],
        });
      }
      if (value.MCP_PUBLIC_BASE_URL) {
        validatePublicBaseUrl(value.MCP_PUBLIC_BASE_URL, context);
        const publicHost = new URL(value.MCP_PUBLIC_BASE_URL).hostname;
        if (!isLoopbackHost(publicHost) && value.MCP_OAUTH_STORE !== "redis") {
          context.addIssue({
            code: "custom",
            message: "非本機 user_oauth 部署必須使用 MCP_OAUTH_STORE=redis",
            path: ["MCP_OAUTH_STORE"],
          });
        }
      }
    }
  });

export interface PingCodeCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AppConfig {
  pingcode: {
    authMode: "enterprise" | "user_oauth";
    apiBaseUrl: string;
    oauthBaseUrl: string;
    credentials: PingCodeCredentials | null;
    requestTimeoutMs: number;
    maxResponseBytes: number;
    maxRetries: number;
    retryBaseDelayMs: number;
    retryMaxDelayMs: number;
  };
  server: {
    host: string;
    port: number;
    allowedHosts: string[];
    publicBaseUrl: string | null;
  };
  oauth: {
    store: "memory" | "redis";
    redisUrl: string | null;
    encryptionKey: string | null;
    cimdEnabled: boolean;
    cimdAllowedHosts: string[];
    dcrClientTtlSeconds: number;
    accessTokenTtlSeconds: number;
    refreshTokenTtlSeconds: number;
  };
  observability: {
    metricsEnabled: boolean;
    metricsBearerToken: string | null;
  };
  logLevel: "debug" | "info" | "warn" | "error";
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.parse(environment);
  const credentials =
    parsed.PINGCODE_CLIENT_ID && parsed.PINGCODE_CLIENT_SECRET
      ? {
          clientId: parsed.PINGCODE_CLIENT_ID,
          clientSecret: parsed.PINGCODE_CLIENT_SECRET,
        }
      : null;

  return {
    pingcode: {
      authMode: parsed.PINGCODE_AUTH_MODE,
      apiBaseUrl: stripTrailingSlash(parsed.PINGCODE_API_BASE_URL),
      oauthBaseUrl: stripTrailingSlash(parsed.PINGCODE_OAUTH_BASE_URL),
      credentials,
      requestTimeoutMs: parsed.PINGCODE_REQUEST_TIMEOUT_MS,
      maxResponseBytes: parsed.PINGCODE_MAX_RESPONSE_BYTES,
      maxRetries: parsed.PINGCODE_MAX_RETRIES,
      retryBaseDelayMs: parsed.PINGCODE_RETRY_BASE_DELAY_MS,
      retryMaxDelayMs: parsed.PINGCODE_RETRY_MAX_DELAY_MS,
    },
    server: {
      host: parsed.MCP_HOST,
      port: parsed.MCP_PORT,
      allowedHosts: parseCsv(parsed.MCP_ALLOWED_HOSTS),
      publicBaseUrl: parsed.MCP_PUBLIC_BASE_URL
        ? stripTrailingSlash(parsed.MCP_PUBLIC_BASE_URL)
        : null,
    },
    oauth: {
      store: parsed.MCP_OAUTH_STORE,
      redisUrl: parsed.MCP_OAUTH_REDIS_URL ?? null,
      encryptionKey: parsed.MCP_OAUTH_ENCRYPTION_KEY ?? null,
      cimdEnabled: parsed.MCP_OAUTH_CIMD_ENABLED,
      cimdAllowedHosts: parseCsv(parsed.MCP_OAUTH_CIMD_ALLOWED_HOSTS).map((host) =>
        host.toLowerCase(),
      ),
      dcrClientTtlSeconds: parsed.MCP_OAUTH_DCR_CLIENT_TTL_SECONDS,
      accessTokenTtlSeconds: parsed.MCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS,
      refreshTokenTtlSeconds: parsed.MCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS,
    },
    observability: {
      metricsEnabled: parsed.MCP_METRICS_ENABLED,
      metricsBearerToken: parsed.MCP_METRICS_BEARER_TOKEN ?? null,
    },
    logLevel: parsed.LOG_LEVEL,
  };
}

function parseCsv(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function isLoopbackHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
}

function validatePublicBaseUrl(
  value: string,
  context: z.RefinementCtx,
): void {
  const url = new URL(value);
  if (url.pathname !== "/" || url.search || url.hash) {
    context.addIssue({
      code: "custom",
      message: "MCP_PUBLIC_BASE_URL 只能包含協議、主機和連接埠，不得包含路徑、查詢或片段",
      path: ["MCP_PUBLIC_BASE_URL"],
    });
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopbackHost(url.hostname))) {
    context.addIssue({
      code: "custom",
      message: "MCP_PUBLIC_BASE_URL 在非本機環境必須使用 HTTPS",
      path: ["MCP_PUBLIC_BASE_URL"],
    });
  }
}

function isValidEncryptionKey(value: string): boolean {
  return /^[A-Za-z0-9+/_-]+={0,2}$/.test(value) && Buffer.from(value, "base64").length === 32;
}
