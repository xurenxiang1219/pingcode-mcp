#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { loadEnvironment } from "./environment.js";
import { createLogger } from "./logger.js";
import { createServices } from "./services.js";
import { startHttpServer } from "./transports/http.js";
import { startStdioServer } from "./transports/stdio.js";
import { createUserOAuthRuntime } from "./auth/runtime.js";

loadEnvironment();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const services = createServices(config, logger);

  if (process.argv.includes("--stdio")) {
    if (config.pingcode.authMode === "user_oauth") {
      throw new Error("user_oauth 只支援 Streamable HTTP；stdio 請使用 enterprise 認證模式");
    }
    await startStdioServer(services, logger);
    return;
  }

  const oauthRuntime =
    config.pingcode.authMode === "user_oauth"
      ? await createUserOAuthRuntime(config, logger)
      : undefined;
  const runningServer = await startHttpServer(config, services, logger, oauthRuntime);
  const shutdown = async (signal: string) => {
    logger.info("正在停止 PingCode MCP HTTP Server", { signal });
    await runningServer.close();
    process.exit(0);
  };

  process.once("SIGINT", () => void shutdown("SIGINT"));
  process.once("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      level: "error",
      message: "PingCode MCP 啟動失敗",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : "未知錯誤",
    })}\n`,
  );
  process.exit(1);
});
