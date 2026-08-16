import type { RequirementContext } from "../domain/requirement-context.js";

export interface RequirementSource {
  getRequirementContext(reference: string): Promise<RequirementContext>;
}
