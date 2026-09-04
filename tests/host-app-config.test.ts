import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { hostConfigFromEnvironment } from "../apps/host/src/config.js";

const base = (): NodeJS.ProcessEnv => ({
  AGENT_MULTIPLEX_SHARED_SECRET: "s".repeat(32),
});

describe("host app configuration", () => {
  it("defaults to a root and keeps enrollment closed", () => {
    expect(hostConfigFromEnvironment(base())).toMatchObject({
      statePath: resolve(".agent-multiplex/host.sqlite"),
      identityPath: resolve(".agent-multiplex/host.sqlite.identity"),
      maxHostDepth: 32,
      enrollment: { workers: false, childHosts: false, observers: false },
      parentHeartbeatMs: 10_000,
    });
    expect(hostConfigFromEnvironment(base()).parent).toBeUndefined();
  });

  it("configures exactly one pinned parent and independent enrollment apertures", () => {
    const config = hostConfigFromEnvironment({
      ...base(),
      AGENT_MULTIPLEX_PARENT_ENDPOINT_ID: "parent-endpoint",
      AGENT_MULTIPLEX_PARENT_TICKET: "parent-ticket",
      AGENT_MULTIPLEX_ALLOW_WORKER_ENROLLMENT: "1",
      AGENT_MULTIPLEX_ALLOW_HOST_ENROLLMENT: "false",
      AGENT_MULTIPLEX_ALLOW_OBSERVER_ENROLLMENT: "true",
    });
    expect(config.parent).toEqual({
      endpointId: "parent-endpoint",
      locator: { kind: "ticket", ticket: "parent-ticket" },
    });
    expect(config.enrollment).toEqual({
      workers: true,
      childHosts: false,
      observers: true,
    });
  });

  it("rejects a half-configured parent and invalid enrollment flags", () => {
    expect(() => hostConfigFromEnvironment({
      ...base(),
      AGENT_MULTIPLEX_PARENT_ENDPOINT_ID: "parent-endpoint",
    })).toThrow(/must be set together/);
    expect(() => hostConfigFromEnvironment({
      ...base(),
      AGENT_MULTIPLEX_ALLOW_ENROLLMENT: "sometimes",
    })).toThrow(/must be 0, 1, false, or true/);
  });
});
