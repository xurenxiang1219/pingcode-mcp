import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createUserOAuthRuntime } from "../src/auth/runtime.js";
import { MemoryOAuthStore } from "../src/auth/memory-store.js";
import { PingCodeOAuthClient } from "../src/auth/pingcode-oauth-client.js";
import { PingCodeOAuthProvider } from "../src/auth/pingcode-oauth-provider.js";
import { EncryptedOAuthStore } from "../src/auth/store.js";
import { TokenCipher } from "../src/auth/token-cipher.js";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/services.js";
import { startHttpServer, type RunningHttpServer } from "../src/transports/http.js";
import { silentLogger } from "./helpers.js";

describe("HTTP user OAuth", () => {
  let runningServer: RunningHttpServer | undefined;

  afterEach(async () => {
    await runningServer?.close();
    runningServer = undefined;
  });

  it("publishes OAuth metadata and protects the MCP endpoint", async () => {
    const config = loadConfig({
      PINGCODE_AUTH_MODE: "user_oauth",
      PINGCODE_CLIENT_ID: "client-id",
      PINGCODE_CLIENT_SECRET: "client-secret",
      MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 5).toString("base64"),
      MCP_METRICS_ENABLED: "true",
      MCP_METRICS_BEARER_TOKEN: "metrics-test-token-that-is-at-least-32-characters",
    });
    config.server.port = 0;
    const services = createServices(config, silentLogger);
    const runtime = await createUserOAuthRuntime(config, silentLogger);
    runningServer = await startHttpServer(config, services, silentLogger, runtime);

    const metadataResponse = await fetch(
      `${runningServer.url}/.well-known/oauth-protected-resource/mcp`,
    );
    expect(metadataResponse.status).toBe(200);
    await expect(metadataResponse.json()).resolves.toMatchObject({
      resource: "http://127.0.0.1:3000/mcp",
      scopes_supported: ["pingcode:wiki:read"],
    });

    const authorizationMetadataResponse = await fetch(
      `${runningServer.url}/.well-known/oauth-authorization-server`,
    );
    expect(authorizationMetadataResponse.status).toBe(200);
    await expect(authorizationMetadataResponse.json()).resolves.toMatchObject({
      client_id_metadata_document_supported: true,
      registration_endpoint: "http://127.0.0.1:3000/register",
    });

    const mcpResponse = await fetch(`${runningServer.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(mcpResponse.status).toBe(401);
    expect(mcpResponse.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
    const wwwAuthenticate = mcpResponse.headers.get("www-authenticate");
    expect(wwwAuthenticate).toContain("/.well-known/oauth-protected-resource/mcp");
    expect(wwwAuthenticate).toContain('error_description="The access token is invalid or expired"');
    expect(wwwAuthenticate).not.toMatch(/[^\x00-\x7f]/);
    await expect(mcpResponse.json()).resolves.toMatchObject({
      error: "invalid_token",
      error_description: "缺少或無效的 Authorization Header",
    });

    const staleTokenResponse = await fetch(`${runningServer.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer token-from-before-restart",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    });
    expect(staleTokenResponse.status).toBe(401);
    expect(staleTokenResponse.headers.get("www-authenticate")).toContain(
      'error_description="The access token is invalid or expired"',
    );
    await expect(staleTokenResponse.json()).resolves.toMatchObject({
      error: "invalid_token",
      error_description: "Access Token 無效或已過期",
    });

    const missingMetricsTokenResponse = await fetch(`${runningServer.url}/metrics`);
    expect(missingMetricsTokenResponse.status).toBe(401);
    await expect(missingMetricsTokenResponse.json()).resolves.toEqual({
      error: "unauthorized",
      message: "缺少或無效的 Metrics Bearer Token",
    });

    const metricsResponse = await fetch(`${runningServer.url}/metrics`, {
      headers: {
        authorization: "Bearer metrics-test-token-that-is-at-least-32-characters",
      },
    });
    expect(metricsResponse.status).toBe(200);
    expect(metricsResponse.headers.get("cache-control")).toBe("no-store");
    await expect(metricsResponse.json()).resolves.toMatchObject({
      mcpHttp: { requestsTotal: expect.any(Number) },
      tools: { callsTotal: expect.any(Number) },
      pingcodeApi: { requestsTotal: expect.any(Number) },
    });
  });

  it("authorizes a CIMD URL client without dynamic registration", async () => {
    const config = loadConfig({
      PINGCODE_AUTH_MODE: "user_oauth",
      PINGCODE_CLIENT_ID: "client-id",
      PINGCODE_CLIENT_SECRET: "client-secret",
      MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 8).toString("base64"),
    });
    config.server.port = 0;
    const clientId = "https://client.example/mcp/client-metadata.json";
    const redirectUri = "http://127.0.0.1:33418/";
    const resolve = vi.fn(async (requestedClientId: string) =>
      requestedClientId === clientId
        ? {
            client_id: clientId,
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
          }
        : undefined,
    );
    const store = new EncryptedOAuthStore(
      new MemoryOAuthStore(),
      new TokenCipher(config.oauth.encryptionKey!),
    );
    const provider = new PingCodeOAuthProvider({
      store,
      pingCodeClient: new PingCodeOAuthClient(
        config.pingcode.oauthBaseUrl,
        config.pingcode.apiBaseUrl,
        config.pingcode.credentials!,
        config.pingcode.requestTimeoutMs,
        silentLogger,
      ),
      cimdClientResolver: { resolve },
      publicBaseUrl: config.server.publicBaseUrl!,
      accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
      logger: silentLogger,
    });
    const runtime = {
      provider,
      ping: () => store.ping(),
      close: () => store.close(),
    };
    runningServer = await startHttpServer(
      config,
      createServices(config, silentLogger),
      silentLogger,
      runtime,
    );

    const authorizeUrl = new URL(`${runningServer.url}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-._~abc",
      code_challenge_method: "S256",
      scope: provider.scope,
      state: "client-state",
      resource: provider.resourceUrl.href,
    }).toString();
    const response = await fetch(authorizeUrl, { redirect: "manual" });

    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/oauth2/authorize");
    expect(resolve).toHaveBeenCalledWith(clientId);
  });

  it("completes DCR, PKCE, PingCode callback and MCP token exchange", async () => {
    const config = loadConfig({
      PINGCODE_AUTH_MODE: "user_oauth",
      PINGCODE_CLIENT_ID: "client-id",
      PINGCODE_CLIENT_SECRET: "client-secret",
      MCP_PUBLIC_BASE_URL: "http://127.0.0.1:3000",
      MCP_OAUTH_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
    });
    config.server.port = 0;
    const upstreamFetch = vi.fn(async () =>
      Response.json({
        access_token: "pingcode-user-token",
        refresh_token: "pingcode-user-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
      }),
    );
    const store = new EncryptedOAuthStore(
      new MemoryOAuthStore(),
      new TokenCipher(config.oauth.encryptionKey!),
    );
    const provider = new PingCodeOAuthProvider({
      store,
      pingCodeClient: new PingCodeOAuthClient(
        config.pingcode.oauthBaseUrl,
        config.pingcode.apiBaseUrl,
        config.pingcode.credentials!,
        config.pingcode.requestTimeoutMs,
        silentLogger,
        upstreamFetch as typeof fetch,
      ),
      publicBaseUrl: config.server.publicBaseUrl!,
      accessTokenTtlSeconds: config.oauth.accessTokenTtlSeconds,
      refreshTokenTtlSeconds: config.oauth.refreshTokenTtlSeconds,
      logger: silentLogger,
    });
    const runtime = {
      provider,
      ping: () => store.ping(),
      close: () => store.close(),
    };
    runningServer = await startHttpServer(
      config,
      createServices(config, silentLogger),
      silentLogger,
      runtime,
    );

    const redirectUri = "http://127.0.0.1:49152/callback";
    const registrationResponse = await fetch(`${runningServer.url}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registrationResponse.status).toBe(201);
    const registeredClient = (await registrationResponse.json()) as { client_id: string };

    const codeVerifier = "a".repeat(64);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const authorizeUrl = new URL(`${runningServer.url}/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: registeredClient.client_id,
      redirect_uri: redirectUri,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
      scope: provider.scope,
      state: "client-state",
      resource: provider.resourceUrl.href,
    }).toString();
    const authorizationResponse = await fetch(authorizeUrl, { redirect: "manual" });
    expect(authorizationResponse.status).toBe(302);
    const pingCodeAuthorizationUrl = new URL(authorizationResponse.headers.get("location")!);
    const upstreamState = pingCodeAuthorizationUrl.searchParams.get("state")!;
    const callbackResponse = await fetch(
      `${runningServer.url}/auth/pingcode/callback?code=pingcode-code&state=${encodeURIComponent(upstreamState)}`,
      {
        redirect: "manual",
        headers: { cookie: authorizationResponse.headers.get("set-cookie")! },
      },
    );
    expect(callbackResponse.status).toBe(302);
    const clientCallbackUrl = new URL(callbackResponse.headers.get("location")!);
    const mcpAuthorizationCode = clientCallbackUrl.searchParams.get("code")!;

    const invalidPkceResponse = await fetch(`${runningServer.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registeredClient.client_id,
        code: mcpAuthorizationCode,
        code_verifier: "wrong-verifier",
        redirect_uri: redirectUri,
        resource: provider.resourceUrl.href,
      }),
    });
    expect(invalidPkceResponse.status).toBe(400);
    await expect(invalidPkceResponse.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const tokenResponse = await fetch(`${runningServer.url}/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: registeredClient.client_id,
        code: mcpAuthorizationCode,
        code_verifier: codeVerifier,
        redirect_uri: redirectUri,
        resource: provider.resourceUrl.href,
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const mcpTokens = (await tokenResponse.json()) as { access_token: string };
    expect(mcpTokens.access_token).not.toBe("pingcode-user-token");

    const initializeResponse = await fetch(`${runningServer.url}/mcp`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${mcpTokens.access_token}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "oauth-http-test", version: "1.0.0" },
        },
      }),
    });
    expect(initializeResponse.status).toBe(200);
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });
});
