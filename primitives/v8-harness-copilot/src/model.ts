/** Paired native model facts. Null effort is a native clear request whose
 * completion is not certified by this pinned protocol's model snapshot. */
export function copilotModelMatches(
  state: Readonly<{ modelId?: unknown; providerId?: unknown; reasoningEffort?: unknown }>,
  requested: Readonly<{ model: string; providerId?: string; effort?: string | null }>,
): boolean {
  return state.modelId === requested.model &&
    (requested.providerId === undefined || state.providerId === requested.providerId) &&
    (requested.effort === undefined || typeof requested.effort === "string" && state.reasoningEffort === requested.effort);
}
