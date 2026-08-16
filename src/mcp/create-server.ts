import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Logger } from "../logger.js";
import type { Services } from "../services.js";
import { registerWikiTools } from "./tools/wiki.js";

export function createMcpServer(services: Services, logger: Logger): McpServer {
  const server = new McpServer({
    name: "pingcode-mcp",
    version: "0.1.0",
  });

  registerWikiTools(server, services, logger);
  return server;
}
