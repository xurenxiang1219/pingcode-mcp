import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { PingCodeClientLike } from "../src/pingcode/client.js";
import { WikiRequirementSource } from "../src/sources/wiki-source.js";

const internalPageId = "6a7f4e2a23b11c9c04645cef";

const pagePayload = {
  id: internalPageId,
  url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}`,
  space: { id: "space-1", name: "Product", identifier: "PRODUCT" },
  name: "Login requirement",
  type: "document",
  short_id: "LOGIN",
  html_url: "https://example.pingcode.com/wiki/pages/LOGIN",
  parent: null,
  tags: [{ id: "tag-1", name: "confirmed" }],
  updated_at: 1786752000,
  is_locked: 0,
  is_archived: 0,
  is_deleted: 0,
};

const contentPayload = {
  id: internalPageId,
  url: `https://open.pingcode.com/v1/wiki/pages/${internalPageId}/content`,
  format_type: "markdown",
  content: "# Login\n\nUsers can sign in.",
};

describe("WikiRequirementSource", () => {
  it("maps PingCode page data into traceable requirement context", async () => {
    const get = vi.fn(async (path: string) => {
      return path.endsWith("/content") ? contentPayload : pagePayload;
    });
    const source = new WikiRequirementSource({ get } as PingCodeClientLike, () => new Date("2026-08-15T00:00:00Z"));

    const context = await source.getRequirementContext(internalPageId);

    expect(context).toMatchObject({
      title: "Login requirement",
      contentFormat: "markdown",
      contentMarkdown: contentPayload.content,
      source: {
        type: "wiki",
        id: internalPageId,
        shortId: "LOGIN",
        spaceId: "space-1",
        retrievedAt: "2026-08-15T00:00:00.000Z",
      },
      tags: [{ id: "tag-1", name: "confirmed" }],
    });
    expect(context.source.contentHash).toBe(
      `sha256:${createHash("sha256").update(contentPayload.content).digest("hex")}`,
    );
    expect(get).toHaveBeenCalledWith(`/v1/wiki/pages/${internalPageId}/content`, { format_type: "markdown" });
  });

  it.each([
    "LOGIN",
    "https://example.pingcode.com/wiki/pages/LOGIN",
    "https://example.pingcode.com/wiki/spaces/PRODUCT/pages/LOGIN",
  ])(
    "resolves short page reference %s before retrieving content",
    async (pageReference) => {
      const get = vi.fn(async (path: string) => {
        if (path === "/v1/wiki/pages") {
          return {
            page_size: 30,
            page_index: 0,
            total: 1,
            values: [pagePayload],
          };
        }
        return path.endsWith("/content") ? contentPayload : pagePayload;
      });
      const source = new WikiRequirementSource({ get } as PingCodeClientLike);

      const context = await source.getRequirementContext(pageReference);

      expect(context.source.id).toBe(internalPageId);
      expect(get).toHaveBeenCalledWith("/v1/wiki/pages", {
        space_id: undefined,
        parent_id: undefined,
        ancestor_id: undefined,
        page_index: 0,
      });
      expect(get).toHaveBeenCalledWith(`/v1/wiki/pages/${internalPageId}`);
    },
  );

  it("searches subsequent page-list batches when resolving a short ID", async () => {
    const get = vi.fn(async (path: string, query?: Record<string, unknown>) => {
      if (path !== "/v1/wiki/pages") {
        return path.endsWith("/content") ? contentPayload : pagePayload;
      }
      return query?.page_index === 0
        ? { page_size: 1, page_index: 0, total: 2, values: [{ ...pagePayload, short_id: "OTHER" }] }
        : { page_size: 1, page_index: 1, total: 2, values: [pagePayload] };
    });
    const source = new WikiRequirementSource({ get } as PingCodeClientLike);

    await expect(source.getRequirementContext("LOGIN")).resolves.toMatchObject({
      source: { id: internalPageId },
    });

    expect(get).toHaveBeenCalledWith("/v1/wiki/pages", expect.objectContaining({ page_index: 1 }));
  });

  it("rejects conflicting page hierarchy filters", async () => {
    const source = new WikiRequirementSource({ get: vi.fn() } as unknown as PingCodeClientLike);

    await expect(source.listPages({ parentId: "parent", ancestorId: "ancestor" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
  });
});
