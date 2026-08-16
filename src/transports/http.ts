import { randomUUID } from "node:crypto";
import type { Server as HttpServer } from "node:http";
import type { Request, Response } from "express";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  createOAuthMetadata,
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
  type AuthRouterOptions,
} from "@modelcontextprotocol/sdk/server/auth/router.js";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { createMcpServer } from "../mcp/create-server.js";
import { metrics } from "../observability/metrics.js";
import { createServices, type Services } from "../services.js";
import type { UserOAuthRuntime } from "../auth/runtime.js";
import { UserOAuthTokenProvider } from "../auth/pingcode-oauth-provider.js";
import { requireSafeBearerAuth } from "./bearer-auth.js";
import { requireMetricsBearerToken } from "./metrics-auth.js";

export interface RunningHttpServer {
  url: string;
  close(): Promise<void>;
}

export async function startHttpServer(
  config: AppConfig,
  services: Services,
  logger: Logger,
  oauthRuntime?: UserOAuthRuntime,
): Promise<RunningHttpServer> {
  const expressOptions =
    config.server.allowedHosts.length > 0
      ? { host: config.server.host, allowedHosts: config.server.allowedHosts }
      : { host: config.server.host };
  const app = createMcpExpressApp(expressOptions);
  app.disable("x-powered-by");

  if (oauthRuntime) {
    const publicBaseUrl = config.server.publicBaseUrl;
    if (!publicBaseUrl) {
      throw new Error("user_oauth 模式缺少 MCP_PUBLIC_BASE_URL");
    }
    const authRouterOptions = {
      provider: oauthRuntime.provider,
      issuerUrl: new URL(publicBaseUrl),
      resourceServerUrl: oauthRuntime.provider.resourceUrl,
      scopesSupported: [oauthRuntime.provider.scope],
      resourceName: "PingCode Wiki MCP",
      clientRegistrationOptions: { clientIdGeneration: false },
    } satisfies AuthRouterOptions;
    if (oauthRuntime.provider.supportsCimd) {
      const metadata = createOAuthMetadata(authRouterOptions);
      app.get("/.well-known/oauth-authorization-server", (_request, response) => {
        response.setHeader("Cache-Control", "public, max-age=300");
        response.json({
          ...metadata,
          client_id_metadata_document_supported: true,
        });
      });
    }
    app.use(mcpAuthRouter(authRouterOptions));
    app.get("/auth/pingcode/callback", (request, response) => {
      void oauthRuntime.provider.handlePingCodeCallback(request, response).catch((error) => {
        logger.error("處理 PingCode OAuth 回調失敗", {
          errorName: error instanceof Error ? error.name : typeof error,
        });
        if (!response.headersSent) {
          response.status(500).send("PingCode OAuth 回調處理失敗");
        }
      });
    });
  }

  app.get("/health/live", (_request, response) => {
    response.json({ status: "ok" });
  });

  app.get("/health/ready", async (_request, response) => {
    try {
      await oauthRuntime?.ping();
      const configured = oauthRuntime !== undefined || services.isConfigured();
      response.status(configured ? 200 : 503).json({
        status: configured ? "ready" : "not_ready",
        pingcodeCredentialsConfigured: configured,
        authMode: config.pingcode.authMode,
      });
    } catch {
      response.status(503).json({
        status: "not_ready",
        pingcodeCredentialsConfigured: true,
        authMode: config.pingcode.authMode,
        oauthStoreReady: false,
      });
    }
  });

  if (config.observability.metricsEnabled && config.observability.metricsBearerToken) {
    app.get(
      "/metrics",
      requireMetricsBearerToken(config.observability.metricsBearerToken),
      (_request, response) => {
        response.setHeader("Cache-Control", "no-store");
        response.json(metrics.snapshot());
      },
    );
  }

  const handleMcpRequest = async (
    request: Request,
    response: Response,
  ) => {
    let requestServices = services;
    if (oauthRuntime) {
      if (!request.auth) {
        response.status(401).json({ error: "unauthorized" });
        return;
      }
      requestServices = createServices(
        config,
        logger,
        new UserOAuthTokenProvider(oauthRuntime.provider, request.auth.token),
      );
    }
    const mcpServer = createMcpServer(requestServices, logger);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    let closed = false;
    const closeResources = () => {
      if (closed) {
        return;
      }
      closed = true;
      void transport.close();
      void mcpServer.close();
    };
    response.once("close", closeResources);

    try {
      await mcpServer.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      logger.error("處理 MCP HTTP 請求失敗", {
        errorName: error instanceof Error ? error.name : typeof error,
      });
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "伺服器內部錯誤" },
          id: null,
        });
      }
      closeResources();
    }
  };

  app.post("/mcp", (request, response, next) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    request.headers["x-request-id"] = requestId;
    response.setHeader("X-Request-ID", requestId);
    response.once("finish", () => {
      const durationMs = Date.now() - startedAt;
      metrics.recordMcpHttpResponse(
        response.statusCode,
        durationMs,
        request.auth !== undefined,
      );
      logger.info("MCP HTTP 請求完成", {
        requestId,
        status: response.statusCode,
        durationMs,
        authenticated: request.auth !== undefined,
      });
    });
    next();
  });

  if (oauthRuntime) {
    app.post(
      "/mcp",
      requireSafeBearerAuth({
        verifier: oauthRuntime.provider,
        requiredScopes: [oauthRuntime.provider.scope],
        resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(oauthRuntime.provider.resourceUrl),
      }),
      handleMcpRequest,
    );
  } else {
    app.post("/mcp", handleMcpRequest);
  }

  const methodNotAllowed = (_request: unknown, response: { status: (code: number) => { json: (body: unknown) => void } }) => {
    response.status(405).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "不允許使用此 HTTP 方法" },
      id: null,
    });
  };
  app.get("/mcp", methodNotAllowed);
  app.delete("/mcp", methodNotAllowed);

  const httpServer = await listen(app, config.server.port, config.server.host);
  const address = httpServer.address();
  const actualPort = typeof address === "object" && address ? address.port : config.server.port;
  const displayHost =
    config.server.host === "0.0.0.0" || config.server.host === "::"
      ? "localhost"
      : config.server.host === "::1"
        ? "[::1]"
        : config.server.host;
  const url = `http://${displayHost}:${actualPort}`;
  logger.info("PingCode MCP HTTP Server 已啟動", {
    host: config.server.host,
    port: actualPort,
    mcpEndpoint: `${url}/mcp`,
    configured: services.isConfigured(),
    authMode: config.pingcode.authMode,
    metricsEnabled: config.observability.metricsEnabled,
  });

  return {
    url,
    close: async () => {
      try {
        await closeHttpServer(httpServer);
      } finally {
        await oauthRuntime?.close();
      }
    },
  };
}

function listen(
  app: ReturnType<typeof createMcpExpressApp>,
  port: number,
  host: string,
): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    const server = app.listen(port, host, () => {
      server.off("error", reject);
      resolve(server);
    });
    server.once("error", reject);
  });
}

function closeHttpServer(server: HttpServer): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
