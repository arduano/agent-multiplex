import type { Json } from "../../contracts/types.js";

/** SDK .19 assigns different meanings to model fields at different lifecycle
 * phases. Preserve those facts explicitly before row metadata is merged. */
export function delegationFacts(type: string, data: Readonly<Record<string, unknown>>): Record<string, Json> {
  const result: Record<string, Json> = {};
  const modelField = type === "subagent.started" ? "startedModel" : type === "subagent.configured" ? "configuredModel" : "reportedUsedModel";
  const fields = { [modelField]: data.model, requestedModel: data.explicitModelOverride,
    configuredModel: type === "subagent.configured" ? data.model : data.configuredModelPreference,
    firstDispatchedModel: data.firstDispatchedModel };
  for (const [key, value] of Object.entries(fields)) if (typeof value === "string" && value.length > 0 && value.length <= 1024) result[key] = value;
  return result;
}
