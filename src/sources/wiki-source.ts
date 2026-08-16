import { createHash } from "node:crypto";
import { PingCodeError } from "../pingcode/errors.js";
import {
  paginatedSchema,
  wikiPageContentSchema,
  wikiPageSchema,
  wikiSpaceSchema,
  type WikiPage,
  type WikiSpace,
} from "../pingcode/schemas.js";
import type { PingCodeClientLike } from "../pingcode/client.js";
import type { RequirementContext } from "../domain/requirement-context.js";
import type { RequirementSource } from "./requirement-source.js";

export interface ListSpacesInput {
  keywords?: string;
  scopeType?: "organization" | "user_group" | "user";
  scopeId?: string;
}

export interface ListPagesInput {
  spaceId?: string;
  parentId?: string;
  ancestorId?: string;
  pageIndex?: number;
}

export interface ListResult<T> {
  pageSize: number;
  pageIndex: number;
  total: number;
  values: T[];
}

export class WikiRequirementSource implements RequirementSource {
  constructor(
    private readonly client: PingCodeClientLike,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listSpaces(input: ListSpacesInput): Promise<ListResult<WikiSpace>> {
    const payload = await this.client.get("/v1/wiki/spaces", {
      keywords: input.keywords,
      scope_type: input.scopeType,
      scope_id: input.scopeId,
      include_deleted: false,
      include_archived: false,
    });
    return mapList(paginatedSchema(wikiSpaceSchema).parse(payload));
  }

  async listPages(input: ListPagesInput): Promise<ListResult<WikiPage>> {
    if (input.parentId && input.ancestorId) {
      throw new PingCodeError("parentId 和 ancestorId 不能同時使用", "BAD_REQUEST");
    }

    const payload = await this.client.get("/v1/wiki/pages", {
      space_id: input.spaceId,
      parent_id: input.parentId,
      ancestor_id: input.ancestorId,
      page_index: input.pageIndex,
    });
    return mapList(paginatedSchema(wikiPageSchema).parse(payload));
  }

  async getRequirementContext(pageReference: string): Promise<RequirementContext> {
    const pageId = await this.resolvePageId(pageReference);

    const [pagePayload, contentPayload] = await Promise.all([
      this.client.get(`/v1/wiki/pages/${encodeURIComponent(pageId)}`),
      this.client.get(`/v1/wiki/pages/${encodeURIComponent(pageId)}/content`, {
        format_type: "markdown",
      }),
    ]);

    const page = wikiPageSchema.parse(pagePayload);
    const content = wikiPageContentSchema.parse(contentPayload);
    if (content.format_type.toLowerCase() !== "markdown") {
      throw new PingCodeError("PingCode 未以 Markdown 格式返回 Wiki 頁面", "INVALID_RESPONSE");
    }

    return {
      source: {
        type: "wiki",
        id: page.id,
        shortId: page.short_id ?? null,
        url: page.html_url,
        apiUrl: page.url,
        spaceId: page.space.id,
        spaceName: page.space.name,
        updatedAt: page.updated_at ?? null,
        retrievedAt: this.now().toISOString(),
        contentHash: `sha256:${createHash("sha256").update(content.content, "utf8").digest("hex")}`,
      },
      title: page.name,
      contentFormat: "markdown",
      contentMarkdown: content.content,
      parent: page.parent
        ? {
            id: page.parent.id,
            title: page.parent.name,
            url: page.parent.html_url ?? null,
          }
        : null,
      tags: (page.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name })),
      attachments: [],
      relatedLinks: [],
    };
  }

  private async resolvePageId(pageReference: string): Promise<string> {
    const normalizedReference = normalizePageReference(pageReference);
    if (/^[0-9a-f]{24}$/i.test(normalizedReference)) {
      return normalizedReference;
    }

    const matches: WikiPage[] = [];
    let pageIndex = 0;

    for (;;) {
      const result = await this.listPages({ pageIndex });
      matches.push(...result.values.filter((page) => page.short_id === normalizedReference));

      const consumed = (result.pageIndex + 1) * result.pageSize;
      if (consumed >= result.total || result.values.length === 0) {
        break;
      }
      pageIndex = result.pageIndex + 1;
    }

    if (matches.length === 0) {
      throw new PingCodeError(`找不到短 ID 為 '${normalizedReference}' 的可存取 PingCode Wiki 頁面`, "NOT_FOUND");
    }
    if (matches.length > 1) {
      throw new PingCodeError(
        `有多個可存取的 PingCode Wiki 頁面使用短 ID '${normalizedReference}'`,
        "BAD_REQUEST",
      );
    }
    return matches[0]!.id;
  }
}

function normalizePageReference(pageReference: string): string {
  const normalized = pageReference.trim();
  if (!normalized) {
    throw new PingCodeError("pageReference 不能為空", "BAD_REQUEST");
  }

  if (!normalized.includes("://")) {
    return normalized;
  }

  let url: URL;
  try {
    url = new URL(normalized);
  } catch {
    throw new PingCodeError("pageReference 不是有效的 Wiki 頁面 URL", "BAD_REQUEST");
  }

  const match = url.pathname.match(/\/wiki\/(?:spaces\/[^/]+\/)?pages\/([^/]+)\/?$/);
  if (!match) {
    throw new PingCodeError("pageReference URL 必須指向 PingCode Wiki 頁面", "BAD_REQUEST");
  }

  try {
    return decodeURIComponent(match[1]!);
  } catch {
    throw new PingCodeError("pageReference URL 包含無效的頁面識別碼", "BAD_REQUEST");
  }
}

function mapList<T>(input: {
  page_size: number;
  page_index: number;
  total: number;
  values: T[];
}): ListResult<T> {
  return {
    pageSize: input.page_size,
    pageIndex: input.page_index,
    total: input.total,
    values: input.values,
  };
}
