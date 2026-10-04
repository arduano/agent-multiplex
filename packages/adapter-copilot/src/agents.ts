import { z } from "zod";
import { NATIVE_PAYLOAD_MAX_BYTES, jsonWireByteUpperBound, type JsonValue } from "@arduano/agent-multiplex-protocol";
import { copilotJson } from "./json.js";

// A registration view, not a native prompt/configuration export. Strip every
// field outside this allowlist, including path, prompt, skills and MCP servers.
const identity = z.string().min(1).max(4_096);
const model = z.string().min(1).max(512);
const agent = z.object({
  id: identity,
  name: identity,
  displayName: z.string().max(4_096),
  description: z.string().max(16_384),
  source: z.enum(["user", "project", "inherited", "remote", "plugin"]).optional(),
  userInvocable: z.boolean().optional(),
  disableModelInvocation: z.boolean().optional(),
  tools: z.array(identity).max(256).optional(),
  model: model.optional(),
  models: z.array(model).max(64).optional(),
  modelPolicy: z.enum(["preferred", "required"]).optional(),
});
const registry = z.object({ agents: z.array(agent).max(1_000) });

export function agentsSnapshot(value: unknown): JsonValue {
  const parsed = registry.safeParse(value);
  if (!parsed.success) throw new TypeError("Unrecognized or oversized Copilot agents snapshot");
  if (jsonWireByteUpperBound(parsed.data) + 256 > NATIVE_PAYLOAD_MAX_BYTES) {
    throw new Error("Copilot agents exceed the bounded native state envelope");
  }
  return copilotJson(parsed.data);
}
