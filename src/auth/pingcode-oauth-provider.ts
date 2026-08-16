import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Request, Response } from "express";
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import type { AccessTokenProvider } from "../pingcode/access-token-provider.js";
import type { Logger } from "../logger.js";
import { PingCodeOAuthClient, type PingCodeUserTokens } from "./pingcode-oauth-client.js";
import type { CimdClientResolverLike } from "./cimd-client-resolver.js";
import type { OAuthStore } from "./store.js";

const WIKI_READ_SCOPE = "pingcode:wiki:read";
const CALLBACK_COOKIE = "pingcode_mcp_oauth_state";
const AUTH_TRANSACTION_TTL_SECONDS = 10 * 60;
const AUTHORIZATION_CODE_TTL_SECONDS = 5 * 60;

const transactionSchema = z.object({
  clientId: z.string(),
  redirectUri: z.url(),
  codeChallenge: z.string(),
  scopes: z.array(z.string()),
  resource: z.url(),
  mcpState: z.string().optional(),
});

const pingCodeTokensSchema = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAtMs: z.number().int().positive(),
});

const authorizationCodeSchema = transactionSchema.extend({
  pingCodeTokens: pingCodeTokensSchema,
});

const tokenBindingSchema = z.object({
  sessionId: z.string(),
  clientId: z.string(),
  scopes: z.array(z.string()),
  resource: z.url(),
  expiresAtSeconds: z.number().int().positive(),
  pairedTokenHash: z.string(),
});

const sessionSchema = z.object({
  pingCodeTokens: pingCodeTokensSchema,
});

interface PingCodeOAuthProviderOptions {
  store: OAuthStore;
  pingCodeClient: PingCodeOAuthClient;
  publicBaseUrl: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  dcrClientTtlSeconds?: number;
  cimdClientResolver?: CimdClientResolverLike;
  logger: Logger;
  now?: () => number;
}

export class PingCodeOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  readonly scope = WIKI_READ_SCOPE;
  readonly resourceUrl: URL;
  readonly callbackUrl: URL;
  readonly supportsCimd: boolean;
  private readonly store: OAuthStore;
  private readonly pingCodeClient: PingCodeOAuthClient;
  private readonly accessTokenTtlSeconds: number;
  private readonly refreshTokenTtlSeconds: number;
  private readonly dcrClientTtlSeconds: number;
  private readonly logger: Logger;
  private readonly cimdClientResolver: CimdClientResolverLike | undefined;
  private readonly now: () => number;
  private readonly secureCookies: boolean;

  constructor(options: PingCodeOAuthProviderOptions) {
    this.store = options.store;
    this.pingCodeClient = options.pingCodeClient;
    this.resourceUrl = new URL("/mcp", `${options.publicBaseUrl}/`);
    this.callbackUrl = new URL("/auth/pingcode/callback", `${options.publicBaseUrl}/`);
    this.accessTokenTtlSeconds = options.accessTokenTtlSeconds;
    this.refreshTokenTtlSeconds = options.refreshTokenTtlSeconds;
    this.dcrClientTtlSeconds = options.dcrClientTtlSeconds ?? 365 * 24 * 60 * 60;
    this.cimdClientResolver = options.cimdClientResolver;
    this.supportsCimd = options.cimdClientResolver !== undefined;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.secureCookies = new URL(options.publicBaseUrl).protocol === "https:";
    this.clientsStore = {
      getClient: (clientId) => this.getClient(clientId),
      registerClient: (client) => this.registerClient(client),
    };
  }

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    response: Response,
  ): Promise<void> {
    this.validateResource(params.resource);
    const scopes = this.validateScopes(params.scopes);
    this.logger.info("開始 PingCode 使用者 OAuth 授權", {
      clientReference: digest(client.client_id).slice(0, 12),
      scopeCount: scopes.length,
    });
    const transactionId = secureToken();
    await this.store.set(
      this.transactionKey(transactionId),
      {
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        scopes,
        resource: this.resourceUrl.href,
        ...(params.state === undefined ? {} : { mcpState: params.state }),
      },
      AUTH_TRANSACTION_TTL_SECONDS,
    );

    response.cookie(CALLBACK_COOKIE, transactionId, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: "lax",
      maxAge: AUTH_TRANSACTION_TTL_SECONDS * 1000,
      path: this.callbackUrl.pathname,
    });
    response.redirect(302, this.pingCodeClient.createAuthorizationUrl(transactionId).href);
  }

  async handlePingCodeCallback(request: Request, response: Response): Promise<void> {
    response.setHeader("Cache-Control", "no-store");
    const queryState = singleQueryValue(request.query.state);
    const cookieState = parseCookies(request.headers.cookie)[CALLBACK_COOKIE];
    response.clearCookie(CALLBACK_COOKIE, {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: "lax",
      path: this.callbackUrl.pathname,
    });

    if (queryState && cookieState && queryState !== cookieState) {
      response.status(400).send("PingCode OAuth state 驗證失敗");
      return;
    }
    const transactionId = queryState ?? cookieState;
    if (!transactionId) {
      response.status(400).send("PingCode OAuth 回調缺少 state");
      return;
    }

    const transactionResult = transactionSchema.safeParse(
      await this.store.consume(this.transactionKey(transactionId)),
    );
    if (!transactionResult.success) {
      response.status(400).send("PingCode OAuth 登入請求已失效，請重新連線");
      return;
    }

    const transaction = transactionResult.data;
    const upstreamError = singleQueryValue(request.query.error);
    if (upstreamError) {
      this.redirectToClient(response, transaction, {
        error: upstreamError === "access_denied" ? "access_denied" : "server_error",
      });
      return;
    }

    const code = singleQueryValue(request.query.code);
    if (!code) {
      this.redirectToClient(response, transaction, { error: "invalid_request" });
      return;
    }

    try {
      const pingCodeTokens = await this.pingCodeClient.exchangeAuthorizationCode(code);
      const authorizationCode = secureToken();
      await this.store.set(
        this.authorizationCodeKey(authorizationCode),
        { ...transaction, pingCodeTokens },
        AUTHORIZATION_CODE_TTL_SECONDS,
      );
      this.redirectToClient(response, transaction, { code: authorizationCode });
      this.logger.info("PingCode 使用者 OAuth 登入完成", { clientId: transaction.clientId });
    } catch (error) {
      this.logger.warn("交換 PingCode 使用者授權碼失敗", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      this.redirectToClient(response, transaction, { error: "server_error" });
    }
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    const record = authorizationCodeSchema.safeParse(
      await this.store.get(this.authorizationCodeKey(authorizationCode)),
    );
    if (!record.success || record.data.clientId !== client.client_id) {
      throw new InvalidGrantError("授權碼無效或已過期");
    }
    return record.data.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const codeKey = this.authorizationCodeKey(authorizationCode);
    const record = authorizationCodeSchema.safeParse(
      await this.store.get(codeKey),
    );
    if (!record.success || record.data.clientId !== client.client_id) {
      throw new InvalidGrantError("授權碼無效或已過期");
    }
    if (redirectUri !== undefined && redirectUri !== record.data.redirectUri) {
      throw new InvalidGrantError("redirect_uri 與原始授權請求不一致");
    }
    this.validateResource(resource, record.data.resource);
    const consumed = authorizationCodeSchema.safeParse(await this.store.consume(codeKey));
    if (!consumed.success || consumed.data.clientId !== client.client_id) {
      throw new InvalidGrantError("授權碼已使用");
    }
    return this.issueTokens(
      randomUUID(),
      client.client_id,
      consumed.data.scopes,
      consumed.data.resource,
      consumed.data.pingCodeTokens,
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    const refreshHash = digest(refreshToken);
    const refreshKey = this.refreshTokenKey(refreshHash);
    const binding = tokenBindingSchema.safeParse(
      await this.store.get(refreshKey),
    );
    if (!binding.success || binding.data.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh Token 無效或已過期");
    }
    this.validateResource(resource, binding.data.resource);
    const requestedScopes = scopes ?? binding.data.scopes;
    if (requestedScopes.some((scope) => !binding.data.scopes.includes(scope))) {
      throw new InvalidScopeError("Refresh Token 不可擴大原有權限範圍");
    }
    const session = sessionSchema.safeParse(await this.store.get(this.sessionKey(binding.data.sessionId)));
    if (!session.success) {
      throw new InvalidGrantError("OAuth Session 已失效");
    }
    const consumed = tokenBindingSchema.safeParse(await this.store.consume(refreshKey));
    if (!consumed.success || consumed.data.clientId !== client.client_id) {
      throw new InvalidGrantError("Refresh Token 已使用");
    }
    await this.store.delete(this.accessTokenKey(binding.data.pairedTokenHash));
    return this.issueTokens(
      binding.data.sessionId,
      client.client_id,
      requestedScopes,
      binding.data.resource,
      session.data.pingCodeTokens,
    );
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const binding = tokenBindingSchema.safeParse(
      await this.store.get(this.accessTokenKey(digest(token))),
    );
    const nowSeconds = Math.floor(this.now() / 1000);
    if (!binding.success || binding.data.expiresAtSeconds <= nowSeconds) {
      throw new InvalidTokenError("Access Token 無效或已過期");
    }
    if (binding.data.resource !== this.resourceUrl.href) {
      throw new InvalidTokenError("Access Token 不適用於此 MCP Resource");
    }
    return {
      token,
      clientId: binding.data.clientId,
      scopes: binding.data.scopes,
      expiresAt: binding.data.expiresAtSeconds,
      resource: new URL(binding.data.resource),
      extra: { sessionId: binding.data.sessionId },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    const tokenHash = digest(request.token);
    const accessKey = this.accessTokenKey(tokenHash);
    const refreshKey = this.refreshTokenKey(tokenHash);
    const [access, refresh] = await Promise.all([
      this.store.get(accessKey),
      this.store.get(refreshKey),
    ]);
    const accessBinding = tokenBindingSchema.safeParse(access);
    const refreshBinding = tokenBindingSchema.safeParse(refresh);
    await Promise.all([
      accessBinding.success && accessBinding.data.clientId === client.client_id
        ? this.store.delete(accessKey)
        : Promise.resolve(),
      refreshBinding.success && refreshBinding.data.clientId === client.client_id
        ? this.store.delete(refreshKey)
        : Promise.resolve(),
    ]);
  }

  async getPingCodeAccessToken(mcpAccessToken: string, forceRefresh = false): Promise<string> {
    const authInfo = await this.verifyAccessToken(mcpAccessToken);
    const sessionId = authInfo.extra?.sessionId;
    if (typeof sessionId !== "string") {
      throw new InvalidTokenError("OAuth Session 綁定無效");
    }

    return this.store.withLock(this.sessionKey(sessionId), async () => {
      const session = sessionSchema.safeParse(await this.store.get(this.sessionKey(sessionId)));
      if (!session.success) {
        throw new InvalidTokenError("OAuth Session 已失效");
      }
      const current = session.data.pingCodeTokens;
      if (!forceRefresh && current.expiresAtMs > this.now() + 60_000) {
        return current.accessToken;
      }
      const refreshed = await this.pingCodeClient.refresh(current.refreshToken);
      await this.store.set(
        this.sessionKey(sessionId),
        { pingCodeTokens: refreshed },
        this.refreshTokenTtlSeconds,
      );
      this.logger.info("已刷新 PingCode 使用者 Token", { sessionId });
      return refreshed.accessToken;
    });
  }

  private async getClient(clientId: string): Promise<OAuthClientInformationFull | undefined> {
    const result = OAuthClientInformationFullSchema.safeParse(
      await this.store.get(this.clientKey(clientId)),
    );
    if (result.success) {
      this.logClientRegistrationMethod(clientId, "DCR");
      return result.data;
    }
    const cimdClient = await this.cimdClientResolver?.resolve(clientId);
    if (cimdClient) {
      this.logClientRegistrationMethod(clientId, "CIMD");
      return cimdClient;
    }
    this.logger.warn("找不到 MCP OAuth Client 註冊", {
      clientReference: digest(clientId).slice(0, 12),
    });
    return undefined;
  }

  private logClientRegistrationMethod(clientId: string, method: "CIMD" | "DCR"): void {
    this.logger.info("已識別 MCP OAuth Client 註冊方式", {
      clientRegistrationMethod: method,
      clientReference: digest(clientId).slice(0, 12),
    });
  }

  private async registerClient(
    client: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">,
  ): Promise<OAuthClientInformationFull> {
    const fullClient = OAuthClientInformationFullSchema.parse({
      ...client,
      client_id: randomUUID(),
      client_id_issued_at: Math.floor(this.now() / 1000),
    });
    await this.store.set(
      this.clientKey(fullClient.client_id),
      fullClient,
      this.dcrClientTtlSeconds,
    );
    this.logger.info("已註冊 MCP OAuth Client", {
      clientReference: digest(fullClient.client_id).slice(0, 12),
      redirectUriCount: fullClient.redirect_uris.length,
      tokenEndpointAuthMethod: fullClient.token_endpoint_auth_method ?? "none",
    });
    return fullClient;
  }

  private async issueTokens(
    sessionId: string,
    clientId: string,
    scopes: string[],
    resource: string,
    pingCodeTokens: PingCodeUserTokens,
  ): Promise<OAuthTokens> {
    const accessToken = secureToken();
    const refreshToken = secureToken();
    const accessHash = digest(accessToken);
    const refreshHash = digest(refreshToken);
    const nowSeconds = Math.floor(this.now() / 1000);
    const common = { sessionId, clientId, scopes, resource };
    await Promise.all([
      this.store.set(
        this.sessionKey(sessionId),
        { pingCodeTokens },
        this.refreshTokenTtlSeconds,
      ),
      this.store.set(
        this.accessTokenKey(accessHash),
        {
          ...common,
          expiresAtSeconds: nowSeconds + this.accessTokenTtlSeconds,
          pairedTokenHash: refreshHash,
        },
        this.accessTokenTtlSeconds,
      ),
      this.store.set(
        this.refreshTokenKey(refreshHash),
        {
          ...common,
          expiresAtSeconds: nowSeconds + this.refreshTokenTtlSeconds,
          pairedTokenHash: accessHash,
        },
        this.refreshTokenTtlSeconds,
      ),
    ]);
    return {
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }

  private validateScopes(scopes: string[] | undefined): string[] {
    const requested = scopes && scopes.length > 0 ? scopes : [WIKI_READ_SCOPE];
    if (requested.some((scope) => scope !== WIKI_READ_SCOPE)) {
      throw new InvalidScopeError(`目前只支援 ${WIKI_READ_SCOPE}`);
    }
    return requested;
  }

  private validateResource(resource: URL | undefined, expected = this.resourceUrl.href): void {
    if (!resource || normalizeUrl(resource) !== normalizeUrl(new URL(expected))) {
      throw new InvalidTargetError(`resource 必須是 ${expected}`);
    }
  }

  private redirectToClient(
    response: Response,
    transaction: z.infer<typeof transactionSchema>,
    result: { code: string } | { error: string },
  ): void {
    const target = new URL(transaction.redirectUri);
    if ("code" in result) {
      target.searchParams.set("code", result.code);
    } else {
      target.searchParams.set("error", result.error);
    }
    if (transaction.mcpState) {
      target.searchParams.set("state", transaction.mcpState);
    }
    response.redirect(302, target.href);
  }

  private clientKey(clientId: string): string {
    return `client:${digest(clientId)}`;
  }

  private transactionKey(transactionId: string): string {
    return `transaction:${digest(transactionId)}`;
  }

  private authorizationCodeKey(code: string): string {
    return `authorization-code:${digest(code)}`;
  }

  private accessTokenKey(tokenHash: string): string {
    return `access-token:${tokenHash}`;
  }

  private refreshTokenKey(tokenHash: string): string {
    return `refresh-token:${tokenHash}`;
  }

  private sessionKey(sessionId: string): string {
    return `session:${digest(sessionId)}`;
  }
}

export class UserOAuthTokenProvider implements AccessTokenProvider {
  private forceRefresh = false;

  constructor(
    private readonly provider: PingCodeOAuthProvider,
    private readonly mcpAccessToken: string,
  ) {}

  async getAccessToken(): Promise<string> {
    const forceRefresh = this.forceRefresh;
    this.forceRefresh = false;
    return this.provider.getPingCodeAccessToken(this.mcpAccessToken, forceRefresh);
  }

  invalidate(): void {
    this.forceRefresh = true;
  }
}

function secureToken(): string {
  return randomBytes(32).toString("base64url");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeUrl(url: URL): string {
  const normalized = new URL(url.href);
  normalized.hash = "";
  return normalized.href.replace(/\/$/, "");
}

function singleQueryValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) {
    return {};
  }
  const entries = header.split(";").flatMap((part) => {
    const separator = part.indexOf("=");
    if (separator < 1) {
      return [];
    }
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    try {
      return [[key, decodeURIComponent(value)] as const];
    } catch {
      return [];
    }
  });
  return Object.fromEntries(entries);
}
