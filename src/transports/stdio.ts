import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Logger } from "../logger.js";
import { createMcpServer } from "../mcp/create-server.js";
import type { Services } from "../services.js";

export async function startStdioServer(services: Services, logger: Logger): Promise<void> {
  const server = createMcpServer(services, logger);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("PingCode MCP stdio Server 已啟動", { configured: services.isConfigured() });
}
