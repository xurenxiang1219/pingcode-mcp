import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("loads safe local defaults without credentials", () => {
    const config = loadConfig({});

    expect(config.pingcode.apiBaseUrl).toBe("https://open.pingcode.com");
    expect(config.pingcode.oauthBaseUrl).toBe("https://open.pingcode.com/oauth2");
    expect(config.pingcode.authMode).toBe("enterprise");
    expect(config.oauth.cimdEnabled).toBe(true);
    expect(config.oauth.cimdAllowedHosts).toEqual([]);
    expect(config.oauth.dcrClientTtlSeconds).toBe(365 * 24 * 60 * 60);
    expect(config.pingcode.credentials).toBeNull();
    expect(config.pingcode).toMatchObject({
      maxRetries: 2,
      retryBaseDelayMs: 250,
      retryMaxDelayMs: 2000,
    });
    expect(config.observability).toEqual({
      metricsEnabled: false,
      metricsBearerToken: null,
    });
    expect(config.server).toMatchObject({ host: "127.0.0.1", port: 3000 });
  });

  it("requires the client id and secret together", () => {
    expect(() => loadConfig({ PINGCODE_CLIENT_ID: "client-id" })).toThrow(
      "PINGCODE_CLIENT_ID 和 PINGCODE_CLIENT_SECRET 必須同時配置",
    );
  });

  it("prevents accidental remote binding", () => {
    expect(() => loadConfig({ MCP_HOST: "0.0.0.0" })).toThrow(
      "將 MCP Server 綁定到非本機位址前，必須設定 MCP_ALLOW_REMOTE=true",
    );
  });

  it("loads a complete local user OAuth configuration", () => {
    const config = loadConfig({
      PINGCODE_AUTH_MODE: "user_oauth",
      PINGCODE_CLIENT_ID: "client-id",
      PINGCODE_CLIENT_SECRET: "client-secret",
      MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    });

    expect(config.pingcode.authMode).toBe("user_oauth");
    expect(config.server.publicBaseUrl).toBe("http://127.0.0.1:3000");
    expect(config.oauth.store).toBe("memory");
  });

  it("requires Redis for a non-local user OAuth deployment", () => {
    expect(() =>
      loadConfig({
        PINGCODE_AUTH_MODE: "user_oauth",
        PINGCODE_CLIENT_ID: "client-id",
        PINGCODE_CLIENT_SECRET: "client-secret",
        MCP_PUBLIC_BASE_URL: "https://mcp.example.com",
        MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      }),
    ).toThrow("非本機 user_oauth 部署必須使用 MCP_OAUTH_STORE=redis");
  });

  it("rejects an invalid OAuth encryption key", () => {
    expect(() =>
      loadConfig({
        PINGCODE_AUTH_MODE: "user_oauth",
        PINGCODE_CLIENT_ID: "client-id",
        PINGCODE_CLIENT_SECRET: "client-secret",
        MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
        MCP_OAUTH_ENCRYPTION_KEY: "too-short",
      }),
    ).toThrow("MCP_OAUTH_ENCRYPTION_KEY 必須是 Base64 編碼的 32-byte 金鑰");
  });

  it("rejects an invalid retry delay range", () => {
    expect(() =>
      loadConfig({
        PINGCODE_RETRY_BASE_DELAY_MS: "2000",
        PINGCODE_RETRY_MAX_DELAY_MS: "1000",
      }),
    ).toThrow("PINGCODE_RETRY_MAX_DELAY_MS 不得小於 PINGCODE_RETRY_BASE_DELAY_MS");
  });

  it("requires a strong independent token when metrics are enabled", () => {
    expect(() => loadConfig({ MCP_METRICS_ENABLED: "true" })).toThrow(
      "啟用 Metrics 時必須配置至少 32 字元的 MCP_METRICS_BEARER_TOKEN",
    );

    const config = loadConfig({
      MCP_METRICS_ENABLED: "true",
      MCP_METRICS_BEARER_TOKEN: "m".repeat(32),
    });
    expect(config.observability).toEqual({
      metricsEnabled: true,
      metricsBearerToken: "m".repeat(32),
    });
  });
});
