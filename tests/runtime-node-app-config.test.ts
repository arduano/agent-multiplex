import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  configFromEnvironment,
  createRuntimeComponents,
} from "../apps/runtime-node/src/main.js";

const requiredEnvironment = (): NodeJS.ProcessEnv => ({
  AGENT_MULTIPLEX_SHARED_SECRET: "x".repeat(32),
  AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "test-control-node-endpoint",
  AGENT_MULTIPLEX_CONTROL_NODE_TICKET: "test-control-node-ticket",
  AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS: '["/tmp"]',
  AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES: "copilot",
});

describe("runtime node Copilot BYOK configuration", () => {
  it("keeps the hidden Copilot UI-server disabled unless explicitly opted in", () => {
    expect(configFromEnvironment(requiredEnvironment())).toMatchObject({
      copilotExperimentalUiServer: false,
    });
    expect(configFromEnvironment({
      ...requiredEnvironment(),
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER: "1",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY: "/opt/copilot-1.0.81",
    })).toMatchObject({
      copilotExperimentalUiServer: true,
      copilotBinary: "/opt/copilot-1.0.81",
    });
    expect(() => configFromEnvironment({
      ...requiredEnvironment(),
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER: "true",
    })).toThrow("must be 0 or 1");
  });

  it("falls back to the structured adapter when the experimental CLI probe fails", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const config = configFromEnvironment({
        ...requiredEnvironment(),
        AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_EXPERIMENTAL_UI_SERVER: "1",
        AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_BINARY:
          "/definitely/not/a/copilot-1.0.81-binary",
      });
      const components = await createRuntimeComponents(config);
      expect(components.adapters).toHaveLength(1);
      expect(components.adapters[0]).toMatchObject({ harness: "copilot" });
      expect(components.terminalProviders).toEqual([]);
      expect(error).toHaveBeenCalledWith(expect.stringContaining(
        "experimental Copilot UI-server unavailable; using structured adapter",
      ));
      await Promise.all(components.adapters.map((adapter) => adapter.close()));
    } finally {
      error.mockRestore();
    }
  });

  it("loads a bearer token from a runtime-node-local file", () => {
    const directory = mkdtempSync(join(tmpdir(), "agent-multiplex-provider-"));
    const tokenFile = join(directory, "token");
    writeFileSync(tokenFile, "local-test-token\n", { mode: 0o600 });
    const config = configFromEnvironment({
      ...requiredEnvironment(),
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL: "https://provider.example/v1",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL: "gpt-5.4",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODELS: '["gpt-5.4","gpt-5.5"]',
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_WIRE_API: "responses",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT: "http",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE: tokenFile,
    });

    expect(config.copilotProvider).toEqual({
      type: "openai",
      baseUrl: "https://provider.example/v1",
      bearerToken: "local-test-token",
      wireApi: "responses",
      transport: "http",
    });
    expect(config.copilotProviderDefaultModel).toBe("gpt-5.4");
    expect(config.copilotProviderModels).toEqual(["gpt-5.4", "gpt-5.5"]);
  });

  it("rejects ambiguous credentials and URLs containing credentials", () => {
    const base = {
      ...requiredEnvironment(),
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL: "gpt-5.4",
    };
    expect(() => configFromEnvironment({
      ...base,
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL: "https://user:pass@provider.example/v1",
    })).toThrow("must not contain credentials");
    expect(() => configFromEnvironment({
      ...base,
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL: "https://provider.example/v1",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE: "/tmp/api-key",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BEARER_TOKEN_FILE: "/tmp/token",
    })).toThrow("mutually exclusive");
    expect(() => configFromEnvironment({
      ...base,
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL: "https://provider.example/v1",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_TRANSPORT: "stdio",
    })).toThrow("must be one of http, websockets");
  });

  it.each([
    ["AGENT_MULTIPLEX_WORKER_NAME", "AGENT_MULTIPLEX_RUNTIME_NODE_NAME"],
    [
      "AGENT_MULTIPLEX_HOST_ENDPOINT_ID",
      "AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID",
    ],
    ["AGENT_MULTIPLEX_ALLOWED_ROOTS", "AGENT_MULTIPLEX_RUNTIME_NODE_ALLOWED_ROOTS"],
    ["AGENT_MULTIPLEX_CODEX_BINARY", "AGENT_MULTIPLEX_RUNTIME_NODE_CODEX_BINARY"],
  ])("rejects removed %s instead of silently accepting it", (legacy, replacement) => {
    expect(() =>
      configFromEnvironment({
        ...requiredEnvironment(),
        [legacy]: "legacy-value",
      }),
    ).toThrow(`${legacy} is a removed protocol-v2 environment variable; use ${replacement}`);
  });
});

it("validates runtime-local BYOK image capability overrides", () => {
  const environment = { ...requiredEnvironment(), AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_BASE_URL: "https://provider.example/v1", AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL: "vision-model" };
  const capabilities = { "vision-model": { supports: { vision: true, reasoningEffort: false }, limits: { max_context_window_tokens: 128000, vision: { supported_media_types: ["image/png"], max_prompt_images: 4, max_prompt_image_size: 3145728 } } } };
  expect(configFromEnvironment({ ...environment, AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES: JSON.stringify(capabilities) }).copilotProviderModelCapabilities).toEqual(capabilities);
  expect(() => configFromEnvironment({ ...environment, AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_MODEL_CAPABILITIES: '{"vision-model":{"supports":{"vision":"yes"}}}' })).toThrow("must map model IDs");
});
