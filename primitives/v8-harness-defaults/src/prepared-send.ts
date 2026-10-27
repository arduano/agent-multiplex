import { isMessageCommand, type Harness, type NativeControlCommand, type NativeMessageCommand } from "../../v8-session/src/contracts/types.js";
import { check, id, frozen } from "../../v8-session/src/contracts/validation.js";
import { artifactInput, inputObject, sendInputLimits } from "../../v8-session/src/contracts/send-inputs.js";
import { validateCommand, validateSelection } from "./validation.js";
import { nativeStateData } from "../../v8-session/src/native/validation.js";

/** Trusted in-process boundary only. Buffers are already privately owned by the
 * preparation lease; never JSON-materialize/freeze typed-array elements. Native
 * encoders snapshot them before asynchronous encoding. */
export function validateNativeCommand(kind: Harness, value: unknown): NativeControlCommand {
  if (value && typeof value === "object" && Object.hasOwn(value, "originalId")) {
    const v = nativeStateData(value) as Record<string, unknown>;
    check(v.type === `${kind}.mcp.login` && Object.keys(v).every(key => ["type", "serverName", "forceReauth", "originalId"].includes(key)));
    const { originalId, ...wire } = v; id(originalId); check(!/[\u0000-\u001f\u007f]/.test(originalId));
    const command = validateCommand(kind, wire); check(command.type === "codex.mcp.login" || command.type === "copilot.mcp.login");
    return frozen({ ...command, originalId });
  }
  if (value && typeof value === "object" && Object.hasOwn(value, "clientUserMessageId")) {
    const v = inputObject(value, ["type", "text", "selection", "nativeInputs", "clientUserMessageId"]); check(kind === "codex" && (v.type === "send" || v.type === "codex.queue.add"));
    const { clientUserMessageId, ...rest } = v; id(clientUserMessageId); check(!/[\u0000-\u001f\u007f]/.test(clientUserMessageId));
    const command = validateNativeCommand(kind, rest); check(command.type === "send" || command.type === "codex.queue.add");
    return Object.freeze({ ...command, clientUserMessageId });
  }
  if (!value || typeof value !== "object" || !Object.hasOwn(value, "nativeInputs")) {
    const command = validateCommand(kind, value);
    check(command.type !== "create" && command.type !== "resume" && command.type !== "stop" && command.type !== "archive");
    check(!isMessageCommand(command) || command.inputs === undefined, "Message inputs require trusted preparation");
    return command;
  }
  const raw = inputObject(value, ["type", "text", "selection", "expectedTurnId", "nativeInputs"]);
  const v = inputObject(raw, raw.type === "send" ? ["type", "text", "selection", "nativeInputs"] : raw.type === "codex.steer" ? ["type", "text", "expectedTurnId", "nativeInputs"] : ["type", "text", "nativeInputs"]);
  check(v.type === "send" || kind === "codex" && (v.type === "codex.steer" || v.type === "codex.queue.add") || kind === "copilot" && v.type === "copilot.steer");
  check(typeof v.text === "string" && v.text.length <= 8192 && !/[\u0000\u000b\u000c\u007f]/.test(v.text));
  if (v.type === "codex.steer") { id(v.expectedTurnId); check(!/[\u0000-\u001f\u007f]/.test(v.expectedTurnId)); }
  const inputs = inputObject(v.nativeInputs, ["kind", "items"]); check(inputs.kind === kind);
  check(Array.isArray(inputs.items) && inputs.items.length > 0 && inputs.items.length <= sendInputLimits.items);
  let total = 0;
  const items = inputs.items.map(raw => {
    const item = inputObject(raw, ["type", "artifact", "bytes", "path", "name", "displayName"]);
    if (item.type === (kind === "codex" ? "image" : "blob")) {
      inputObject(item, ["type", "artifact", "bytes"]); const artifact = artifactInput(item.artifact);
      check(item.bytes instanceof Uint8Array && item.bytes.buffer instanceof ArrayBuffer && item.bytes.byteLength === artifact.bytes);
      total += item.bytes.byteLength; check(total <= sendInputLimits.totalBytes);
      return Object.freeze({ type: item.type, artifact, bytes: item.bytes });
    }
    check(kind === "codex" ? item.type === "localImage" || item.type === "mention" : item.type === "file");
    inputObject(item, item.type === "mention" ? ["type", "path", "name"] : item.type === "file" ? ["type", "path", "displayName"] : ["type", "path"]);
    check(typeof item.path === "string" && item.path.length > 0 && item.path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(item.path));
    if (item.type === "mention") check(typeof item.name === "string" && item.name.length > 0 && item.name.length <= 256);
    if (item.displayName !== undefined) check(typeof item.displayName === "string" && item.displayName.length > 0 && item.displayName.length <= 256);
    return Object.freeze({ ...item });
  });
  const selection = v.selection === undefined ? undefined : validateSelection(kind, v.selection);
  return Object.freeze({ type: v.type, text: v.text, ...(v.type === "codex.steer" ? { expectedTurnId: v.expectedTurnId } : {}), ...(selection === undefined ? {} : { selection }), nativeInputs: Object.freeze({ kind, items: Object.freeze(items) }) }) as NativeMessageCommand;
}
