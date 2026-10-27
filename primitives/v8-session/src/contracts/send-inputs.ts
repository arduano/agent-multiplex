import type { ArtifactRef, DiskRef, FileScope } from "../../../v8-files/src/contracts/types.js";
import type { Harness, SendInputsFor } from "./types.js";
import { check, frozen } from "./validation.js";

export const sendInputLimits = Object.freeze({ items: 8, artifactBytes: 10 * 1024 * 1024, totalBytes: 20 * 1024 * 1024 });
export function inputObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
  check(Object.keys(value).every(key => keys.includes(key) && "value" in Object.getOwnPropertyDescriptor(value, key)!));
  return value as Record<string, unknown>;
}
function inputText(value: unknown, maximum = 256): asserts value is string { check(typeof value === "string" && value.length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value)); }
function owner(value: unknown): FileScope {
  const v = inputObject(value, ["connection", "principal", "host", "session"]);
  for (const key of ["connection", "principal", "host", "session"]) inputText(v[key]);
  return frozen({ ...v }) as FileScope;
}
export function artifactInput(value: unknown): ArtifactRef {
  const v = inputObject(value, ["kind", "owner", "id", "name", "mediaType", "bytes", "sha256", "capturedAt"]);
  check(v.kind === "artifact"); inputText(v.id); check(/^[a-zA-Z0-9_.-]+$/.test(v.id) && v.id !== "." && v.id !== "..");
  inputText(v.name); inputText(v.mediaType); check(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(v.mediaType));
  check(Number.isSafeInteger(v.bytes) && (v.bytes as number) >= 0 && (v.bytes as number) <= sendInputLimits.artifactBytes);
  check(typeof v.sha256 === "string" && /^[a-f0-9]{64}$/.test(v.sha256));
  check(Number.isSafeInteger(v.capturedAt) && (v.capturedAt as number) >= 0);
  return frozen({ ...v, owner: owner(v.owner) }) as ArtifactRef;
}
function diskInput(value: unknown): DiskRef {
  const v = inputObject(value, ["kind", "owner", "sourceKey", "path"]);
  check(v.kind === "disk"); inputText(v.sourceKey); inputText(v.path, 4096);
  return frozen({ ...v, owner: owner(v.owner) }) as DiskRef;
}
export function validateSendInputs<K extends Harness>(kind: K, value: unknown): SendInputsFor<K> {
  const v = inputObject(value, ["kind", "items"]); check(v.kind === kind);
  check(Array.isArray(v.items) && v.items.length > 0 && v.items.length <= sendInputLimits.items);
  let bytes = 0;
  const items = v.items.map(raw => {
    const item = inputObject(raw, ["type", "artifact", "file", "name", "displayName"]);
    if (item.type === (kind === "codex" ? "image" : "blob")) {
      inputObject(item, ["type", "artifact"]); const artifact = artifactInput(item.artifact); bytes += artifact.bytes;
      check(bytes <= sendInputLimits.totalBytes); return { type: item.type, artifact };
    }
    check(kind === "codex" ? item.type === "localImage" || item.type === "mention" : item.type === "file");
    inputObject(item, item.type === "mention" ? ["type", "file", "name"] : item.type === "file" ? ["type", "file", "displayName"] : ["type", "file"]);
    const file = diskInput(item.file);
    if (item.type === "mention") inputText(item.name);
    if (item.displayName !== undefined) inputText(item.displayName);
    return { type: item.type, file, ...(item.name === undefined ? {} : { name: item.name }), ...(item.displayName === undefined ? {} : { displayName: item.displayName }) };
  });
  return frozen({ kind, items }) as unknown as SendInputsFor<K>;
}
