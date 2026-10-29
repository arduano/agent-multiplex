import {
  canonicalJson,
  scopeKey,
  type Json,
  type Receipt,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import type { ConfirmedDraftAttachment, DraftAttachmentLimits } from "../contracts.js";

export class ClientError extends Error {
  constructor(
    readonly code:
      "INVALID" | "FULL" | "FENCED" | "CONFLICT" | "PERSISTENCE" | "CLOSED" | "PENDING_WORK",
  ) {
    super(code);
    this.name = "ClientError";
  }
}
export function check(value: unknown, code: ClientError["code"] = "INVALID"): asserts value {
  if (!value) throw new ClientError(code);
}
export function id(value: unknown): asserts value is string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(value),
  );
}
export function json(value: unknown, maximum = 16777216): string {
  try {
    return canonicalJson(value as Json, maximum).json;
  } catch {
    throw new ClientError("INVALID");
  }
}
export function immutable<T>(value: T): T {
  const copy = JSON.parse(json(value)) as T;
  const freeze = (item: unknown): void => {
    if (item && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  freeze(copy);
  return copy;
}
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
export function runKey(run: RunRef): string {
  json(run, 4096);
  id(run.nativeSession);
  check(Number.isSafeInteger(run.generation) && run.generation > 0);
  return JSON.stringify([scopeKey(run.scope), run.generation, run.nativeSession]);
}
export function sameScope(a: SessionScope, b: SessionScope): boolean {
  return scopeKey(a) === scopeKey(b);
}
export function draftAttachments(
  value: readonly ConfirmedDraftAttachment[],
  scope: SessionScope,
  limits: DraftAttachmentLimits,
): readonly ConfirmedDraftAttachment[] {
  check(Array.isArray(value) && value.length <= limits.maxFiles, "FULL");
  let bytes = 0;
  const ids = new Set<string>();
  for (const file of value) {
    check(
      file &&
        Object.keys(file).sort().join(",") ===
          "bytes,id,kind,mediaType,name,origin,retention,scope,sha256" &&
        file.kind === "stored",
    );
    check(sameScope(file.scope, scope), "FENCED");
    id(file.id);
    id(file.name);
    check(!ids.has(file.id), "CONFLICT");
    ids.add(file.id);
    check(
      Number.isSafeInteger(file.bytes) && file.bytes >= 0 && /^[a-f0-9]{64}$/.test(file.sha256),
    );
    check(
      typeof file.mediaType === "string" &&
        file.mediaType.length <= 256 &&
        !/[\x00-\x1f\x7f]/.test(file.mediaType) &&
        ["upload", "capture"].includes(file.origin) &&
        ["session", "cache"].includes(file.retention),
    );
    bytes += file.bytes;
  }
  check(bytes <= limits.maxBytes, "FULL");
  return immutable(value);
}
export function receiptFor(
  value: Receipt,
  scope: SessionScope,
  originalId: string,
  previous: Receipt | null = null,
): Receipt {
  json(value);
  check(sameScope(value.scope, scope) && value.id === originalId, "FENCED");
  check(
    /^[a-f0-9]{64}$/.test(value.requestHash) &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0,
  );
  check(["admitted", "dispatched", "unknown", "succeeded", "refused"].includes(value.state));
  check(value.state === "succeeded" || value.state === "refused" || value.result === null);
  if (previous) {
    check(value.requestHash === previous.requestHash, "CONFLICT");
    if (value.revision < previous.revision) return previous;
    if (value.revision === previous.revision) check(json(value) === json(previous), "CONFLICT");
    if (["succeeded", "refused"].includes(previous.state))
      check(
        value.state === previous.state && json(value.result) === json(previous.result),
        "CONFLICT",
      );
  }
  return immutable(value);
}
