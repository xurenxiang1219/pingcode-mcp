export interface RequirementContext {
  source: {
    type: "wiki";
    id: string;
    shortId: string | null;
    url: string;
    apiUrl: string;
    spaceId: string;
    spaceName: string;
    updatedAt: number | null;
    retrievedAt: string;
    contentHash: string;
  };
  title: string;
  contentFormat: "markdown";
  contentMarkdown: string;
  parent: {
    id: string;
    title: string;
    url: string | null;
  } | null;
  tags: Array<{ id: string; name: string }>;
  attachments: [];
  relatedLinks: [];
}
