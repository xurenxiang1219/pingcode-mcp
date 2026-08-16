import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import type { Logger } from "../../logger.js";
import type { Services } from "../../services.js";
import { executeTool, requestIdForLog } from "../tool-runtime.js";

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: true,
};

const spaceSummarySchema = z.object({
  id: z.string(),
  identifier: z.string(),
  name: z.string(),
  visibility: z.string().nullable(),
  description: z.string().nullable(),
  updatedAt: z.number().nullable(),
});

const pageSummarySchema = z.object({
  id: z.string(),
  shortId: z.string().nullable(),
  name: z.string(),
  type: z.string(),
  url: z.string(),
  spaceId: z.string(),
  spaceName: z.string(),
  parentId: z.string().nullable(),
  updatedAt: z.number().nullable(),
  archived: z.boolean(),
  deleted: z.boolean(),
});

const requirementContextSchema = z.object({
  source: z.object({
    type: z.literal("wiki"),
    id: z.string(),
    shortId: z.string().nullable(),
    url: z.string(),
    apiUrl: z.string(),
    spaceId: z.string(),
    spaceName: z.string(),
    updatedAt: z.number().nullable(),
    retrievedAt: z.string(),
    contentHash: z.string(),
  }),
  title: z.string(),
  contentFormat: z.literal("markdown"),
  contentMarkdown: z.string(),
  parent: z
    .object({
      id: z.string(),
      title: z.string(),
      url: z.string().nullable(),
    })
    .nullable(),
  tags: z.array(z.object({ id: z.string(), name: z.string() })),
  attachments: z.array(z.never()),
  relatedLinks: z.array(z.never()),
});

export function registerWikiTools(server: McpServer, services: Services, logger: Logger): void {
  server.registerTool(
    "pingcode_wiki_list_spaces",
    {
      title: "列出 PingCode Wiki 空間",
      description: "列出目前憑據可存取的 PingCode Wiki 空間。此操作為唯讀，不會生成規格文件。",
      inputSchema: {
        keywords: z.string().trim().min(1).max(200).optional().describe("選填的空間名稱關鍵字"),
        scope_type: z.enum(["organization", "user_group", "user"]).optional(),
        scope_id: z.string().trim().min(1).optional().describe("部分範圍查詢需要提供此 PingCode 範圍 ID"),
      },
      outputSchema: {
        pageSize: z.number(),
        pageIndex: z.number(),
        total: z.number(),
        spaces: z.array(spaceSummarySchema),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ keywords, scope_type, scope_id }, extra) =>
      executeTool(
        logger,
        "pingcode_wiki_list_spaces",
        requestIdForLog(extra.requestInfo?.headers["x-request-id"], extra.requestId),
        {
          hasKeywords: keywords !== undefined,
          scopeType: scope_type ?? null,
          hasScopeId: scope_id !== undefined,
        },
        async () => {
          const result = await services.getWikiSource().listSpaces({
            ...(keywords === undefined ? {} : { keywords }),
            ...(scope_type === undefined ? {} : { scopeType: scope_type }),
            ...(scope_id === undefined ? {} : { scopeId: scope_id }),
          });
          return {
            pageSize: result.pageSize,
            pageIndex: result.pageIndex,
            total: result.total,
            spaces: result.values.map((space) => ({
              id: space.id,
              identifier: space.identifier,
              name: space.name,
              visibility: space.visibility ?? null,
              description: space.description ?? null,
              updatedAt: space.updated_at ?? null,
            })),
          };
        },
      ),
  );

  server.registerTool(
    "pingcode_wiki_list_pages",
    {
      title: "列出 PingCode Wiki 頁面",
      description:
        "列出可存取的 Wiki 頁面，可依空間、直接父頁面或祖先頁面篩選。parent_id 和 ancestor_id 不能同時使用。",
      inputSchema: {
        space_id: z.string().trim().min(1).optional(),
        parent_id: z.string().trim().min(1).optional(),
        ancestor_id: z.string().trim().min(1).optional(),
      },
      outputSchema: {
        pageSize: z.number(),
        pageIndex: z.number(),
        total: z.number(),
        pages: z.array(pageSummarySchema),
      },
      annotations: readOnlyAnnotations,
    },
    async ({ space_id, parent_id, ancestor_id }, extra) =>
      executeTool(
        logger,
        "pingcode_wiki_list_pages",
        requestIdForLog(extra.requestInfo?.headers["x-request-id"], extra.requestId),
        {
          filterType: space_id
            ? "space"
            : parent_id
              ? "parent"
              : ancestor_id
                ? "ancestor"
                : "none",
          ...(space_id ?? parent_id ?? ancestor_id
            ? { resourceId: space_id ?? parent_id ?? ancestor_id }
            : {}),
        },
        async () => {
          const result = await services.getWikiSource().listPages({
            ...(space_id === undefined ? {} : { spaceId: space_id }),
            ...(parent_id === undefined ? {} : { parentId: parent_id }),
            ...(ancestor_id === undefined ? {} : { ancestorId: ancestor_id }),
          });
          return {
            pageSize: result.pageSize,
            pageIndex: result.pageIndex,
            total: result.total,
            pages: result.values.map((page) => ({
              id: page.id,
              shortId: page.short_id ?? null,
              name: page.name,
              type: page.type,
              url: page.html_url,
              spaceId: page.space.id,
              spaceName: page.space.name,
              parentId: page.parent?.id ?? null,
              updatedAt: page.updated_at ?? null,
              archived: toBoolean(page.is_archived),
              deleted: toBoolean(page.is_deleted),
            })),
          };
        },
      ),
  );

  server.registerTool(
    "pingcode_wiki_get_requirement_context",
    {
      title: "取得 PingCode Wiki 需求上下文",
      description:
        "取得 Wiki 頁面及其 Markdown 正文，作為 Coding Agent 或 Spec Kit 可追溯的需求上下文。支援內部頁面 ID、短 ID 或完整 Wiki 頁面 URL。此 Tool 不會調用 AI 模型或寫入文件。",
      inputSchema: {
        page_id: z
          .string()
          .trim()
          .min(1)
          .describe("PingCode Wiki 內部頁面 ID、短 ID 或完整頁面 URL"),
      },
      outputSchema: requirementContextSchema.shape,
      annotations: readOnlyAnnotations,
    },
    async ({ page_id }, extra) =>
      executeTool(
        logger,
        "pingcode_wiki_get_requirement_context",
        requestIdForLog(extra.requestInfo?.headers["x-request-id"], extra.requestId),
        { resourceId: pageReferenceForLog(page_id) },
        () => services.getWikiSource().getRequirementContext(page_id),
      ),
  );
}

function pageReferenceForLog(value: string): string {
  if (!value.includes("://")) {
    return value;
  }
  try {
    const segments = new URL(value).pathname.split("/").filter(Boolean);
    return decodeURIComponent(segments.at(-1) ?? "unknown");
  } catch {
    return "invalid-url";
  }
}

function toBoolean(value: boolean | number | undefined): boolean {
  return value === true || value === 1;
}
