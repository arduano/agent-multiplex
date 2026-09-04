import { newRuntimeEpoch } from "@arduano/agent-multiplex-protocol";
import type { AdapterEvent } from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

import { MockAgentAdapter } from "../src/index.js";

describe("MockAgentAdapter", () => {
  it("streams deterministic Codex-shaped turns and keeps native history", async () => {
    const adapter = new MockAgentAdapter({ streamIntervalMs: 1, chunkCount: 6 });
    const session = await adapter.spawn({ harness: "codex", cwd: "/tmp" });
    const events: AdapterEvent[] = [];
    session.subscribe((event) => events.push(event));

    const result = await session.execute({
      harness: "codex",
      command: { type: "send", input: "hello" },
    });
    expect(result).toMatchObject({ accepted: true, mock: true });
    await waitFor(() => native(events, "turn/completed").length === 1);

    const deltas = native(events, "item/agentMessage/delta");
    expect(deltas).toHaveLength(6);
    const sourceTimestamps = native(events).map((event) =>
      Number(event.payload.emittedAtMs),
    );
    expect(sourceTimestamps).toHaveLength(10);
    expect(sourceTimestamps.every(Number.isSafeInteger)).toBe(true);
    expect(sourceTimestamps.every((value, index) =>
      index === 0 || value >= sourceTimestamps[index - 1]!)).toBe(true);
    const response = deltas.map((event) => String(event.payload.delta)).join("");
    expect(response).toContain(`session=${session.vendorSessionId}`);
    expect(response).toContain("tick=6");
    expect(native(events, "item/completed")[0]?.payload.item).toMatchObject({
      type: "agentMessage",
      text: response,
    });
    await expect(session.readNativeHistory({ harness: "codex" })).resolves.toMatchObject({
      complete: true,
      payload: { thread: { turns: [{ status: "completed" }] } },
    });
    await adapter.close();
  });

  it("isolates concurrent sessions and cancels an interrupted stream", async () => {
    const adapter = new MockAgentAdapter({ streamIntervalMs: 2, chunkCount: 20 });
    const sessions = await Promise.all(
      Array.from({ length: 12 }, () =>
        adapter.spawn({ harness: "codex", cwd: "/tmp" }),
      ),
    );
    expect(new Set(sessions.map((session) => session.vendorSessionId)).size).toBe(12);
    const events = new Map(sessions.map((session) => [session.vendorSessionId, [] as AdapterEvent[]]));
    sessions.forEach((session) =>
      session.subscribe((event) => events.get(session.vendorSessionId)?.push(event)),
    );
    await Promise.all(sessions.map((session, index) => session.execute({
      harness: "codex",
      command: { type: "send", input: `prompt-${index}` },
    })));
    await sessions[0]?.execute({ harness: "codex", command: { type: "interrupt" } });
    await waitFor(() => sessions.slice(1).every((session) =>
      native(events.get(session.vendorSessionId) ?? [], "turn/completed").length === 1,
    ));
    const interrupted = native(events.get(sessions[0]?.vendorSessionId ?? "") ?? [], "turn/completed");
    expect(interrupted.at(-1)?.payload.turn).toMatchObject({ status: "interrupted" });
    for (const [index, session] of sessions.slice(1).entries()) {
      const text = native(events.get(session.vendorSessionId) ?? [], "item/agentMessage/delta")
        .map((event) => String(event.payload.delta)).join("");
      expect(text).toContain(`prompt=prompt-${index + 1}`);
      expect(text).not.toContain("prompt=prompt-0");
    }
    await adapter.close();
  });

  it("lists stopped sessions as resumable and assigns a new runtime epoch", async () => {
    const epochs = [newRuntimeEpoch(), newRuntimeEpoch()];
    const adapter = new MockAgentAdapter({
      runtimeEpochFactory: () => epochs.shift() ?? newRuntimeEpoch(),
    });
    const first = await adapter.spawn({ harness: "codex", cwd: "/tmp" });
    await first.stop();
    await expect(adapter.listSessions()).resolves.toMatchObject([
      { availability: "resumable", runtimeStatus: "stopped", runtimeEpoch: null },
    ]);
    const resumed = await adapter.resume({
      harness: "codex",
      vendorSessionId: first.vendorSessionId,
      cwd: "/tmp",
    });
    expect(resumed.runtimeEpoch).not.toBe(first.runtimeEpoch);
    await adapter.close();
  });

  it("publishes model, mode, and effort as durable snapshots and settings events", async () => {
    const adapter = new MockAgentAdapter();
    const session = await adapter.spawn({
      harness: "codex",
      cwd: "/tmp",
      model: "mock-model-a",
      effort: "low",
      collaborationMode: { mode: "plan" },
    });
    const initial = {
      model: "mock-model-a",
      mode: "plan",
      effort: "low",
    };
    expect(session.settings?.()).toEqual(initial);
    await expect(adapter.listSessions()).resolves.toMatchObject([
      { vendorSessionId: session.vendorSessionId, harnessSettings: initial },
    ]);

    const events: AdapterEvent[] = [];
    session.subscribe((event) => events.push(event));
    await session.execute({
      harness: "codex",
      command: { type: "setModel", model: "mock-model-b" },
    });
    await session.execute({
      harness: "codex",
      command: { type: "setMode", mode: "default" },
    });
    await session.execute({
      harness: "codex",
      command: { type: "setEffort", effort: "high" },
    });

    const snapshots = events
      .filter((event): event is Extract<AdapterEvent, { kind: "settings" }> =>
        event.kind === "settings")
      .map((event) => event.settings);
    expect(snapshots).toEqual([
      { model: "mock-model-b", mode: "plan", effort: "low" },
      { model: "mock-model-b", mode: "default", effort: "low" },
      { model: "mock-model-b", mode: "default", effort: "high" },
    ]);
    expect(native(events, "thread/settings/updated")).toMatchObject([
      {
        payload: {
          threadSettings: {
            model: "mock-model-b",
            effort: "low",
            collaborationMode: { mode: "plan" },
          },
        },
      },
      {
        payload: {
          threadSettings: {
            model: "mock-model-b",
            effort: "low",
            collaborationMode: "default",
          },
        },
      },
      {
        payload: {
          threadSettings: {
            model: "mock-model-b",
            effort: "high",
            collaborationMode: "default",
          },
        },
      },
    ]);
    const finalSettings = {
      model: "mock-model-b",
      mode: "default",
      effort: "high",
    };
    expect(session.settings?.()).toEqual(finalSettings);
    await expect(adapter.listSessions()).resolves.toMatchObject([
      {
        harnessSettings: finalSettings,
        nativeSummary: {
          model: "mock-model-b",
          effort: "high",
        },
      },
    ]);

    await session.stop();
    const resumed = await adapter.resume({
      harness: "codex",
      vendorSessionId: session.vendorSessionId,
      cwd: "/tmp",
      model: "mock-model-c",
      effort: "medium",
      collaborationMode: { mode: "plan" },
    });
    expect(resumed.settings?.()).toEqual({
      model: "mock-model-c",
      mode: "plan",
      effort: "medium",
    });
    await expect(adapter.listSessions()).resolves.toMatchObject([
      {
        availability: "active",
        harnessSettings: {
          model: "mock-model-c",
          mode: "plan",
          effort: "medium",
        },
      },
    ]);
    await adapter.close();
  });
});

function native(events: AdapterEvent[], type?: string) {
  return events.filter(
    (event): event is Extract<AdapterEvent, { kind: "native" }> =>
      event.kind === "native" && (type === undefined || event.nativeType === type),
  );
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for mock events");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
