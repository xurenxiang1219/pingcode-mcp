import { describe, expect, it, vi } from "vitest";
import { EnterpriseTokenProvider } from "../src/pingcode/token-provider.js";
import { silentLogger } from "./helpers.js";

describe("EnterpriseTokenProvider", () => {
  it("obtains and caches an enterprise token", async () => {
    const nowMs = Date.UTC(2026, 7, 15, 0, 0, 0);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://open.pingcode.com");
      expect(url.pathname).toBe("/v1/auth/token");
      expect(url.searchParams.get("grant_type")).toBe("client_credentials");
      expect(url.searchParams.get("client_id")).toBe("test-client");
      expect(url.searchParams.get("client_secret")).toBe("test-secret");

      return new Response(
        JSON.stringify({
          access_token: "enterprise-token",
          token_type: "Bearer",
          expires_in: Math.floor(nowMs / 1000) + 3600,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const provider = new EnterpriseTokenProvider(
      "https://open.pingcode.com",
      { clientId: "test-client", clientSecret: "test-secret" },
      5000,
      silentLogger,
      fetchMock as typeof fetch,
      () => nowMs,
    );

    await expect(provider.getAccessToken()).resolves.toBe("enterprise-token");
    await expect(provider.getAccessToken()).resolves.toBe("enterprise-token");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose an upstream authentication response body", async () => {
    const fetchMock = vi.fn(async () => new Response("secret details", { status: 401 }));
    const provider = new EnterpriseTokenProvider(
      "https://open.pingcode.com",
      { clientId: "test-client", clientSecret: "test-secret" },
      5000,
      silentLogger,
      fetchMock as typeof fetch,
    );

    await expect(provider.getAccessToken()).rejects.toMatchObject({
      code: "AUTHENTICATION_FAILED",
      message: "PingCode 拒絕了企業應用憑據",
    });
  });

  it("preserves a private deployment API root path", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      expect(new URL(String(input)).pathname).toBe("/open/v1/auth/token");
      return Response.json({
        access_token: "enterprise-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    const provider = new EnterpriseTokenProvider(
      "https://pingcode.example.com/open",
      { clientId: "test-client", clientSecret: "test-secret" },
      5000,
      silentLogger,
      fetchMock as typeof fetch,
    );

    await expect(provider.getAccessToken()).resolves.toBe("enterprise-token");
  });
});
