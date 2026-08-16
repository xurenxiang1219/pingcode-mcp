import type { Request, Response } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import { MemoryOAuthStore } from "../src/auth/memory-store.js";
import { PingCodeOAuthClient } from "../src/auth/pingcode-oauth-client.js";
import { PingCodeOAuthProvider } from "../src/auth/pingcode-oauth-provider.js";
import { EncryptedOAuthStore } from "../src/auth/store.js";
import { TokenCipher } from "../src/auth/token-cipher.js";
import { silentLogger } from "./helpers.js";

describe("PingCodeOAuthProvider", () => {
  it("brokers PingCode user OAuth without exposing upstream tokens", async () => {
    const nowMs = Date.UTC(2026, 7, 16, 0, 0, 0);
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://open.pingcode.com");
      expect(url.pathname).toBe("/v1/auth/token");
      if (url.searchParams.get("grant_type") === "authorization_code") {
        expect(url.searchParams.get("client_secret")).toBe("pingcode-secret");
        return Response.json({
          access_token: "pingcode-access-token",
          refresh_token: "pingcode-refresh-token",
          token_type: "Bearer",
          expires_in: 3600,
        });
      }
      expect(url.searchParams.get("grant_type")).toBe("refresh_token");
      expect(url.searchParams.get("refresh_token")).toBe("pingcode-refresh-token");
      return Response.json({
        access_token: "pingcode-refreshed-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      });
    });
    const rawStore = new MemoryOAuthStore(() => nowMs);
    const store = new EncryptedOAuthStore(
      rawStore,
      new TokenCipher(Buffer.alloc(32, 9).toString("base64")),
    );
    const pingCodeClient = new PingCodeOAuthClient(
      "https://open.pingcode.com/oauth2",
      "https://open.pingcode.com",
      { clientId: "pingcode-client", clientSecret: "pingcode-secret" },
      5000,
      silentLogger,
      fetchMock as typeof fetch,
      () => nowMs,
    );
    const provider = new PingCodeOAuthProvider({
      store,
      pingCodeClient,
      publicBaseUrl: "http://127.0.0.1:3000",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      logger: silentLogger,
      now: () => nowMs,
    });
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      token_endpoint_auth_method: "none",
    });
    const identifiedClient = await provider.clientsStore.getClient!(client.client_id);
    expect(identifiedClient).toMatchObject({ client_id: client.client_id });

    const authorizationResponse = createResponseRecorder();
    await provider.authorize(
      client,
      {
        state: "mcp-client-state",
        scopes: [provider.scope],
        redirectUri: client.redirect_uris[0]!,
        codeChallenge: "pkce-code-challenge",
        resource: provider.resourceUrl,
      },
      authorizationResponse.response,
    );
    const pingCodeAuthorizeUrl = new URL(authorizationResponse.redirectUrl!);
    const upstreamState = pingCodeAuthorizeUrl.searchParams.get("state")!;
    expect(pingCodeAuthorizeUrl.origin).toBe("https://open.pingcode.com");
    expect(pingCodeAuthorizeUrl.pathname).toBe("/oauth2/authorize");
    expect(pingCodeAuthorizeUrl.searchParams.get("client_secret")).toBeNull();

    const callbackResponse = createResponseRecorder();
    await provider.handlePingCodeCallback(
      {
        query: { code: "upstream-code", state: upstreamState },
        headers: { cookie: `pingcode_mcp_oauth_state=${upstreamState}` },
      } as unknown as Request,
      callbackResponse.response,
    );
    const clientCallbackUrl = new URL(callbackResponse.redirectUrl!);
    const authorizationCode = clientCallbackUrl.searchParams.get("code")!;
    expect(clientCallbackUrl.searchParams.get("state")).toBe("mcp-client-state");
    await expect(provider.challengeForAuthorizationCode(client, authorizationCode)).resolves.toBe(
      "pkce-code-challenge",
    );
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        authorizationCode,
        undefined,
        client.redirect_uris[0],
        new URL("https://other.example/mcp"),
      ),
    ).rejects.toBeInstanceOf(InvalidTargetError);

    const tokens = await provider.exchangeAuthorizationCode(
      client,
      authorizationCode,
      undefined,
      client.redirect_uris[0],
      provider.resourceUrl,
    );
    expect(tokens.access_token).not.toBe("pingcode-access-token");
    expect(tokens.refresh_token).not.toBe("pingcode-refresh-token");
    await expect(provider.getPingCodeAccessToken(tokens.access_token)).resolves.toBe(
      "pingcode-access-token",
    );
    await expect(provider.getPingCodeAccessToken(tokens.access_token, true)).resolves.toBe(
      "pingcode-refreshed-access-token",
    );
    await expect(
      provider.exchangeAuthorizationCode(
        client,
        authorizationCode,
        undefined,
        client.redirect_uris[0],
        provider.resourceUrl,
      ),
    ).rejects.toBeInstanceOf(InvalidGrantError);

    await expect(
      provider.exchangeRefreshToken(
        client,
        tokens.refresh_token!,
        ["pingcode:admin"],
        provider.resourceUrl,
      ),
    ).rejects.toBeInstanceOf(InvalidScopeError);
    const refreshedMcpTokens = await provider.exchangeRefreshToken(
      client,
      tokens.refresh_token!,
      [provider.scope],
      provider.resourceUrl,
    );
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toThrow();
    await expect(provider.verifyAccessToken(refreshedMcpTokens.access_token)).resolves.toMatchObject({
      clientId: client.client_id,
      scopes: [provider.scope],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects authorization for another MCP resource", async () => {
    const store = new EncryptedOAuthStore(
      new MemoryOAuthStore(),
      new TokenCipher(Buffer.alloc(32, 3).toString("base64")),
    );
    const provider = new PingCodeOAuthProvider({
      store,
      pingCodeClient: new PingCodeOAuthClient(
        "https://open.pingcode.com/oauth2",
        "https://open.pingcode.com",
        { clientId: "client", clientSecret: "secret" },
        5000,
        silentLogger,
      ),
      publicBaseUrl: "http://127.0.0.1:3000",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      logger: silentLogger,
    });
    const client = await provider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      token_endpoint_auth_method: "none",
    });

    await expect(
      provider.authorize(
        client,
        {
          redirectUri: client.redirect_uris[0]!,
          codeChallenge: "challenge",
          resource: new URL("https://other.example/mcp"),
        },
        createResponseRecorder().response,
      ),
    ).rejects.toBeInstanceOf(InvalidTargetError);
  });

  it("logs whether a client was identified by CIMD or DCR", async () => {
    const info = vi.fn();
    const logger = { ...silentLogger, info };
    const store = new EncryptedOAuthStore(
      new MemoryOAuthStore(),
      new TokenCipher(Buffer.alloc(32, 4).toString("base64")),
    );
    const provider = new PingCodeOAuthProvider({
      store,
      pingCodeClient: new PingCodeOAuthClient(
        "https://open.pingcode.com/oauth2",
        "https://open.pingcode.com",
        { clientId: "client", clientSecret: "secret" },
        5000,
        logger,
      ),
      publicBaseUrl: "http://127.0.0.1:3000",
      accessTokenTtlSeconds: 3600,
      refreshTokenTtlSeconds: 86400,
      cimdClientResolver: {
        resolve: async (clientId) =>
          clientId === "https://client.example/metadata.json"
            ? {
                client_id: clientId,
                redirect_uris: ["http://127.0.0.1:49152/callback"],
                token_endpoint_auth_method: "none",
              }
            : undefined,
      },
      logger,
    });
    const dcrClient = await provider.clientsStore.registerClient!({
      redirect_uris: ["http://127.0.0.1:49152/callback"],
      token_endpoint_auth_method: "none",
    });
    await provider.clientsStore.getClient!(dcrClient.client_id);
    await provider.clientsStore.getClient!("https://client.example/metadata.json");

    expect(info).toHaveBeenCalledWith(
      "已識別 MCP OAuth Client 註冊方式",
      expect.objectContaining({ clientRegistrationMethod: "DCR" }),
    );
    expect(info).toHaveBeenCalledWith(
      "已識別 MCP OAuth Client 註冊方式",
      expect.objectContaining({ clientRegistrationMethod: "CIMD" }),
    );
  });
});

function createResponseRecorder(): {
  response: Response;
  redirectUrl?: string;
} {
  const recorder: {
    response: Response;
    redirectUrl?: string;
  } = { response: undefined as unknown as Response };
  const response = {
    cookie: vi.fn(),
    clearCookie: vi.fn(),
    setHeader: vi.fn(),
    redirect: vi.fn((_status: number, url: string) => {
      recorder.redirectUrl = url;
    }),
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
  };
  recorder.response = response as unknown as Response;
  return recorder;
}
