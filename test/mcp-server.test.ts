import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PingCodeClientLike } from "../src/pingcode/client.js";
import { createMcpServer } from "../src/mcp/create-server.js";
import type { Services } from "../src/services.js";
import { WikiRequirementSource } from "../src/sources/wiki-source.js";
import type { Logger } from "../src/logger.js";
import { silentLogger } from "./helpers.js";

const connected: Array<{ client: Client; server: ReturnType<typeof createMcpServer> }> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).map(async ({ client, server }) => Promise.all([client.close(), server.close()])));
});

describe("PingCode MCP server", () => {
  it("advertises read-only Wiki tools and returns requirement context", async () => {
    const internalPageId = "6a7f4e2a23b11c9c04645cef";
    const get = vi.fn(async (path: string) => {
      if (path.endsWith("/content")) {
        return {
          id: internalPageId,
          url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}/content`,
          format_type: "markdown",
          content: "# Requirement",
        };
      }
      return {
        id: internalPageId,
        url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}`,
        space: { id: "space-1", name: "Product" },
        name: "Requirement",
        type: "document",
        html_url: "https://example.pingcode.com/wiki/pages/page-1",
        parent: null,
        updated_at: 1786752000,
      };
    });
    const wikiSource = new WikiRequirementSource({ get } as PingCodeClientLike, () => new Date("2026-08-15T00:00:00Z"));
    const services: Services = {
      isConfigured: () => true,
      getWikiSource: () => wikiSource,
    };
    const server = createMcpServer(services, silentLogger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connected.push({ client, server });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "pingcode_wiki_list_spaces",
      "pingcode_wiki_list_pages",
      "pingcode_wiki_get_requirement_context",
    ]);
    expect(tools.tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);

    const result = await client.callTool({
      name: "pingcode_wiki_get_requirement_context",
      arguments: { page_id: internalPageId },
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      title: "Requirement",
      contentMarkdown: "# Requirement",
      source: { id: internalPageId, type: "wiki" },
    });
  });

  it("logs successful tool execution without logging Wiki content", async () => {
    const info = vi.fn();
    const logger: Logger = {
      ...silentLogger,
      info,
    };
    const internalPageId = "6a7f4e2a23b11c9c04645cef";
    const secretMarkdown = "# 不應出現在日誌的正文";
    const get = vi.fn(async (path: string) =>
      path.endsWith("/content")
        ? {
            id: internalPageId,
            url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}/content`,
            format_type: "markdown",
            content: secretMarkdown,
          }
        : {
            id: internalPageId,
            url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}`,
            space: { id: "space-1", name: "Product" },
            name: "Requirement",
            type: "document",
            html_url: "https://example.pingcode.com/wiki/pages/page-1",
            parent: null,
          },
    );
    const services: Services = {
      isConfigured: () => true,
      getWikiSource: () => new WikiRequirementSource({ get } as PingCodeClientLike),
    };
    const server = createMcpServer(services, logger);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connected.push({ client, server });
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await client.callTool({
      name: "pingcode_wiki_get_requirement_context",
      arguments: { page_id: internalPageId },
    });

    expect(info).toHaveBeenCalledWith(
      "開始執行 PingCode MCP Tool",
      expect.objectContaining({
        toolName: "pingcode_wiki_get_requirement_context",
        resourceId: internalPageId,
      }),
    );
    expect(info).toHaveBeenCalledWith(
      "PingCode MCP Tool 執行完成",
      expect.objectContaining({ status: "success", durationMs: expect.any(Number) }),
    );
    expect(JSON.stringify(info.mock.calls)).not.toContain(secretMarkdown);
  });
});
