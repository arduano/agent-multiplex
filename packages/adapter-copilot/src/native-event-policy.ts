import type { AdapterNativeEvent } from "@arduano/agent-multiplex-runtime-node-core";

/**
 * The pinned CLI's ephemeral model.messages_snapshot is a diagnostic copy of
 * model context, not a request, settlement, or lifecycle observation. It is not
 * declared by SDK 1.0.14's generated SessionEvent union, but CLI 1.0.88's
 * loopback fixture emits it after the authoritative assistant.turn_end.
 * No other model/debug events or arbitrary ephemeral events are exempted.
 */
export function copilotOptionalNativeTelemetry(event: AdapterNativeEvent): boolean {
  if (event.nativeType !== "model.messages_snapshot" || event.ephemeral !== true) return false;
  const payload = record(event.payload);
  const data = record(payload?.data);
  return payload?.type === event.nativeType && payload.ephemeral === true &&
    data?.kind === "messages_snapshot" && Array.isArray(data.messages);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
