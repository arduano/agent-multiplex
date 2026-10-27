import type { Origin, Scope } from "./types.js";
function originKey(origin: Origin, attachment: boolean): readonly string[] {
  return [origin.connection, origin.principal, origin.host, origin.nativeSession, ...(attachment ? [origin.attachment] : [])];
}
/** JSON arrays preserve boundaries; concatenated opaque IDs do not. */
export function scopeKey(scope: Scope): string {
  return JSON.stringify([...originKey(scope.origin, true), scope.kind, ...(scope.kind === "codex" ? [scope.threadId] : [scope.agentId, scope.legacyParentToolCallId ?? null])]);
}
/** Transport/native attachment epochs fence current facts inside this retained presentation identity. */
export function conversationKey(scope: Scope): string {
  return JSON.stringify([...originKey(scope.origin, false), scope.kind, ...(scope.kind === "codex" ? [scope.threadId] : [scope.agentId, scope.legacyParentToolCallId ?? null])]);
}
export function sameScope(a: Scope, b: Scope): boolean { return scopeKey(a) === scopeKey(b); }
export function sameConversation(a: Scope, b: Scope): boolean { return conversationKey(a) === conversationKey(b); }
