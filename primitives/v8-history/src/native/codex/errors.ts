import type { HistoryRecord } from "../../acquisition/types.js";
import type { Json, Row } from "../../contracts/types.js";
import { mediaDigest } from "../../contracts/media.js";
import { invariant, object } from "../../contracts/validation.js";

/** A complete diagnostic is not evidence that its native turn completed. */
export type CodexErrorRow = Readonly<{ message: string; willRetry: boolean }>;
export function codexErrorRow(row: Pick<Row, "kind" | "native" | "body">): CodexErrorRow | undefined {
  if (row.kind !== "notice" || row.native.type !== "turnError" || typeof row.native.willRetry !== "boolean" || row.body.kind === "unavailable") return undefined;
  return { message: row.body.text, willRetry: row.native.willRetry };
}

/** Shared live/read projection. No raw provider details, request or credentials are copied. */
export function codexErrorRecord(threadId: string, turnId: string, value: unknown, willRetry: boolean): HistoryRecord {
  const error = object(value), message = error.message;
  invariant(typeof message === "string" && message.length <= 65_536 && new TextEncoder().encode(message).byteLength <= 65_536, "CODEX_ERROR_MESSAGE_BOUND");
  const native: Record<string, Json> = { type: "turnError", threadId, turnId, willRetry };
  // Native permits extensible code objects. Retain their public discriminator,
  // not arbitrary nested diagnostics or additionalDetails.
  const info = error.codexErrorInfo;
  const code = typeof info === "string" ? info : info && typeof info === "object" && !Array.isArray(info) && Object.keys(info).length === 1 ? Object.keys(info)[0] : undefined;
  if (typeof code === "string" && /^[A-Za-z][A-Za-z0-9]{0,255}$/.test(code)) native.codexErrorInfo = code;
  const digest = mediaDigest(new TextEncoder().encode(message));
  return { id: `codex:error:${JSON.stringify([threadId, turnId, willRetry, digest])}`, kind: "notice", lifecycle: "completed",
    body: { kind: "complete", text: message, evidence: "nativeFullBody" }, native };
}
