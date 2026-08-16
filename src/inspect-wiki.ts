#!/usr/bin/env node

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "./config.js";
import { loadEnvironment } from "./environment.js";
import { createLogger } from "./logger.js";
import { createMcpServer } from "./mcp/create-server.js";
import { createServices } from "./services.js";

loadEnvironment();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes("--json");
  const unknownOptions = args.filter((arg) => arg.startsWith("--") && arg !== "--json");
  const pageReferences = args.filter((arg) => !arg.startsWith("--"));

  if (unknownOptions.length > 0 || pageReferences.length !== 1) {
    throw new Error(
      "用法：npm run inspect:wiki -- '<頁面 ID 或 URL>' [--json]。此命令會輸出完整 Wiki 正文。",
    );
  }

  const config = loadConfig();
  if (config.pingcode.authMode === "user_oauth") {
    throw new Error("inspect:wiki 只支援 enterprise；user_oauth 請透過 HTTP MCP Client 讀取 Wiki");
  }
  const logger = createLogger("error");
  const services = createServices(config, logger);
  if (!services.isConfigured()) {
    throw new Error(".env 中尚未配置 PingCode 憑據");
  }

  const server = createMcpServer(services, logger);
  const client = new Client({ name: "pingcode-wiki-inspector", version: "0.1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const result = await client.callTool({
      name: "pingcode_wiki_get_requirement_context",
      arguments: { page_id: pageReferences[0]! },
    });

    if (result.isError) {
      const message = getTextContent(result.content);
      throw new Error(message || "MCP Tool 返回錯誤");
    }

    const output = result.structuredContent;
    if (!isRecord(output)) {
      throw new Error("MCP Tool 未返回結構化內容");
    }

    if (!jsonOutput) {
      const markdown = output.contentMarkdown;
      if (typeof markdown !== "string") {
        throw new Error("MCP 響應中不包含 contentMarkdown");
      }
      process.stdout.write(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
      return;
    }

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    await client.close();
    await server.close();
  }
}

function getTextContent(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter((item): item is { type: "text"; text: string } => {
      return isRecord(item) && item.type === "text" && typeof item.text === "string";
    })
    .map((item) => item.text)
    .join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

main().catch((error) => {
  process.stderr.write(
    `${JSON.stringify({
      status: "error",
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : "未知錯誤",
    })}\n`,
  );
  process.exit(1);
});
