import { z } from "zod";

const actorSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    display_name: z.string().optional(),
  })
  .passthrough();

const pageReferenceSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    short_id: z.string().optional(),
    html_url: z.string().optional(),
  })
  .passthrough();

export const wikiSpaceSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    identifier: z.string(),
    name: z.string(),
    scope_type: z.string().optional(),
    scope_id: z.string().optional().nullable(),
    visibility: z.string().optional(),
    description: z.string().optional().nullable(),
    updated_at: z.number().optional(),
    is_archived: z.union([z.number(), z.boolean()]).optional(),
    is_deleted: z.union([z.number(), z.boolean()]).optional(),
  })
  .passthrough();

export const wikiPageSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    space: z
      .object({
        id: z.string(),
        name: z.string(),
        identifier: z.string().optional(),
      })
      .passthrough(),
    name: z.string(),
    type: z.string(),
    short_id: z.string().optional(),
    html_url: z.string(),
    parent: pageReferenceSchema.nullable().optional(),
    tags: z.array(z.object({ id: z.string(), name: z.string() }).passthrough()).optional(),
    published_at: z.number().optional(),
    published_by: actorSchema.optional(),
    created_at: z.number().optional(),
    updated_at: z.number().optional(),
    is_locked: z.union([z.number(), z.boolean()]).optional(),
    is_archived: z.union([z.number(), z.boolean()]).optional(),
    is_deleted: z.union([z.number(), z.boolean()]).optional(),
  })
  .passthrough();

export const wikiPageContentSchema = z
  .object({
    id: z.string(),
    url: z.string(),
    format_type: z.string(),
    content: z.string(),
  })
  .passthrough();

export function paginatedSchema<T extends z.ZodType>(itemSchema: T) {
  return z.object({
    page_size: z.number(),
    page_index: z.number(),
    total: z.number(),
    values: z.array(itemSchema),
  });
}

export const enterpriseTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().default("Bearer"),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

export const userOAuthTokenSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().default("Bearer"),
  expires_in: z.union([z.number(), z.string()]).optional(),
});

export type WikiSpace = z.infer<typeof wikiSpaceSchema>;
export type WikiPage = z.infer<typeof wikiPageSchema>;
export type WikiPageContent = z.infer<typeof wikiPageContentSchema>;
