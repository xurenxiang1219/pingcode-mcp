#!/usr/bin/env node

import { loadConfig } from "./config.js";
import { loadEnvironment } from "./environment.js";
import { createLogger } from "./logger.js";
import { PingCodeError } from "./pingcode/errors.js";
import { createServices } from "./services.js";

loadEnvironment();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  if (config.pingcode.authMode === "user_oauth") {
    throw new Error("verify:pingcode 只支援 enterprise；user_oauth 請透過 HTTP MCP Client 登入驗證");
  }
  const services = createServices(config, logger);

  if (!services.isConfigured()) {
    throw new Error(".env 中尚未配置 PingCode 憑據");
  }

  const wikiSource = services.getWikiSource();
  const spaces = await wikiSource.listSpaces({});
  const pageReference = process.argv[2]?.trim();
  const pageSummary = pageReference ? await verifyPage(wikiSource, pageReference) : null;

  process.stdout.write(
    `${JSON.stringify(
      {
        status: "ok",
        apiBaseUrl: config.pingcode.apiBaseUrl,
        spaces: {
          returned: spaces.values.length,
          total: spaces.total,
        },
        ...(pageSummary ? { page: pageSummary } : {}),
      },
      null,
      2,
    )}\n`,
  );
}

async function verifyPage(
  wikiSource: ReturnType<ReturnType<typeof createServices>["getWikiSource"]>,
  pageReference: string,
) {
  const context = await wikiSource.getRequirementContext(pageReference);
  return {
    id: context.source.id,
    title: context.title,
    sourceUrl: context.source.url,
    contentBytes: Buffer.byteLength(context.contentMarkdown, "utf8"),
    contentHash: context.source.contentHash,
  };
}

main().catch((error) => {
  const pingCodeDetails =
    error instanceof PingCodeError
      ? {
          code: error.code,
          status: error.options.status,
          retryable: error.retryable,
          ...(error.options.requestId ? { requestId: error.options.requestId } : {}),
        }
      : {};
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : "未知錯誤",
      ...pingCodeDetails,
    })}\n`,
  );
  process.exit(1);
});
