import { RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

import {
  CONTROL_NODE_LOCATOR_SETTING_KEY,
  PersistentControlNodeLocator,
  connectWithBootstrapFallback,
} from "../apps/runtime-node/src/control-node-locator.js";

const bootstrap = (endpointId: string, ticket: string) => ({
  endpointId,
  locator: { kind: "ticket" as const, ticket },
});

describe("PersistentControlNodeLocator", () => {
  it("persists bootstrap and prefers a renewed ticket for the same endpoint", () => {
    const store = new RuntimeNodeStore(":memory:");
    const first = new PersistentControlNodeLocator(store, bootstrap("control-node-a", "bootstrap-a"));
    expect(first.currentTarget()).toEqual(bootstrap("control-node-a", "bootstrap-a"));
    expect(first.acceptRenewedTicket("renewed-a")).toBe(true);

    const restarted = new PersistentControlNodeLocator(
      store,
      bootstrap("control-node-a", "new-bootstrap-a"),
    );
    expect(restarted.currentTarget()).toEqual(bootstrap("control-node-a", "renewed-a"));
    expect(restarted.bootstrapTarget()).toEqual(bootstrap("control-node-a", "new-bootstrap-a"));
    store.close();
  });

  it("never reuses a stored ticket when the configured endpoint pin changes", () => {
    const store = new RuntimeNodeStore(":memory:");
    const old = new PersistentControlNodeLocator(store, bootstrap("control-node-old", "old-ticket"));
    old.acceptRenewedTicket("old-renewed-ticket");

    const changed = new PersistentControlNodeLocator(store, bootstrap("control-node-new", "new-ticket"));
    expect(changed.currentTarget()).toEqual(bootstrap("control-node-new", "new-ticket"));
    expect(JSON.parse(store.getSetting(CONTROL_NODE_LOCATOR_SETTING_KEY)!)).toEqual({
      version: 3,
      endpointId: "control-node-new",
      ticket: "new-ticket",
    });
    store.close();
  });

  it("falls back to bootstrap after a stored ticket fails and persists success", async () => {
    const store = new RuntimeNodeStore(":memory:");
    const locator = new PersistentControlNodeLocator(store, bootstrap("control-node-a", "bootstrap"));
    locator.acceptRenewedTicket("expired-renewal");
    const attempted: string[] = [];

    await expect(
      connectWithBootstrapFallback({
        locator,
        connect: async (target) => {
          if (target.locator.kind !== "ticket") throw new Error("unexpected locator");
          attempted.push(target.locator.ticket);
          if (target.locator.ticket === "expired-renewal") throw new Error("expired");
          return "connected";
        },
      }),
    ).resolves.toBe("connected");

    expect(attempted).toEqual(["expired-renewal", "bootstrap"]);
    expect(locator.currentTarget()).toEqual(bootstrap("control-node-a", "bootstrap"));
    store.close();
  });

  it("does not repeat the same bootstrap ticket after it fails", async () => {
    const store = new RuntimeNodeStore(":memory:");
    const locator = new PersistentControlNodeLocator(store, bootstrap("control-node-a", "bootstrap"));
    let attempts = 0;
    await expect(
      connectWithBootstrapFallback({
        locator,
        connect: async () => {
          attempts += 1;
          throw new Error("offline");
        },
      }),
    ).rejects.toThrow("offline");
    expect(attempts).toBe(1);
    store.close();
  });
});
