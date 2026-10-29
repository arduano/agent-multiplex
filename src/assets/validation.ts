import {
  canonicalJson,
  scopeKey,
  type Json,
  type RunRef,
  type SessionScope,
} from "../protocol/index.js";
import { AssetError, uploadSpecSchema, type UploadSpec } from "./contracts.js";
export function check(value: unknown, code: AssetError["code"] = "INVALID"): asserts value {
  if (!value) throw new AssetError(code);
}
export function identifier(value: string): string {
  check(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 256 &&
      !/[\x00-\x1f\x7f]/.test(value),
  );
  return value;
}
export function scope(value: SessionScope): SessionScope {
  scopeKey(value);
  return {
    connection: value.connection,
    principal: value.principal,
    host: value.host,
    session: value.session,
  };
}
export function run(value: RunRef): RunRef {
  check(Number.isSafeInteger(value.generation) && value.generation > 0);
  return {
    scope: scope(value.scope),
    generation: value.generation,
    nativeSession: identifier(value.nativeSession),
  };
}
export function spec(value: UploadSpec): UploadSpec {
  const parsed = uploadSpecSchema.safeParse(value);
  check(parsed.success);
  return {
    id: value.id,
    name: value.name,
    bytes: value.bytes,
    sha256: value.sha256,
    mediaType: value.mediaType,
    retention: value.retention ?? "session",
  };
}
export const equal = (a: unknown, b: unknown): boolean =>
  canonicalJson(a as Json, 16384).json === canonicalJson(b as Json, 16384).json;
