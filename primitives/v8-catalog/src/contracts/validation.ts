import { canonical, copy } from "../../../v8-session/src/contracts/validation.js";
import { validateSelection } from "../../../v8-harness-defaults/src/validation.js";
import { CatalogError, type ArchivePublication, type CatalogScope, type CreateRequest, type HostTarget, type NativeBinding, type RenameRequest, type WatchRequest, type MetadataRequest } from "./types.js";
export { canonical, copy };
export function check(ok: unknown): asserts ok { if (!ok) throw new CatalogError("INVALID"); }
export function id(value: unknown): asserts value is string { check(typeof value === "string" && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value)); }
function keys(v: unknown, allowed: readonly string[]): asserts v is Record<string, unknown> { check(v && typeof v === "object" && !Array.isArray(v) && Object.keys(v).every(k => allowed.includes(k))); }
export function scope(s: CatalogScope): void { keys(s, ["connection", "principal", "authority"]); id(s.connection); id(s.principal); id(s.authority); }
export function target(t: HostTarget): void { keys(t, ["host", "owner", "kind", "placement"]); id(t.host); id(t.owner); check(["codex", "copilot"].includes(t.kind) && ["shared", "dedicated"].includes(t.placement)); }
export function name(v: unknown): void { check(v === null || typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v)); }
export function create(r: CreateRequest): CreateRequest {
  canonical(r); keys(r, ["scope", "id", "session", "target", "metadata", "selection"]); scope(r.scope); id(r.id); id(r.session); target(r.target);
  keys(r.metadata, ["name", "cwd"]); name(r.metadata.name); check(r.metadata.cwd === null || typeof r.metadata.cwd === "string" && r.metadata.cwd.length > 0 && r.metadata.cwd.length <= 4096 && !r.metadata.cwd.includes("\0"));
  if (r.selection !== undefined) validateSelection(r.target.kind, r.selection);
  return copy(r);
}
export function rename(r: RenameRequest): RenameRequest { canonical(r); keys(r, ["scope", "id", "session", "revision", "name"]); scope(r.scope); id(r.id); id(r.session); name(r.name); check(Number.isSafeInteger(r.revision) && r.revision >= 1); return copy(r); }
export function watch(r: WatchRequest): WatchRequest { canonical(r); keys(r, ["scope", "id", "session", "revision", "watched"]); scope(r.scope); id(r.id); id(r.session); check(typeof r.watched === "boolean" && Number.isSafeInteger(r.revision) && r.revision >= 1); return copy(r); }
export function metadata(r: MetadataRequest): MetadataRequest { check(r && typeof r === "object" && !Array.isArray(r)); return Object.hasOwn(r, "watched") ? watch(r as WatchRequest) : rename(r as RenameRequest); }
export function archive(r: ArchivePublication): ArchivePublication { canonical(r); keys(r, ["scope", "session", "id", "generation"]); scope(r.scope); id(r.session); id(r.id); check(Number.isSafeInteger(r.generation) && r.generation >= 0); return copy(r); }
export function binding(b: NativeBinding, expected: HostTarget): NativeBinding { keys(b, ["nativeSession", "generation", "kind", "placement"]); id(b.nativeSession); check(Number.isSafeInteger(b.generation) && b.generation >= 1 && b.kind === expected.kind && b.placement === expected.placement); return copy(b); }
