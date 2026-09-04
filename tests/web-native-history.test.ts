import { describe, expect, it, vi } from "vitest";

import {
  advanceNativeHistorySignal,
  isRetryableNativeHistoryError,
  nativeHistoryInitiallyReady,
  retryNativeHistory,
  sessionBindingIdentity,
} from "../apps/web/src/client/native-history.js";

const binding = {
  sessionId: "session-a",
  bindingRevision: 1,
  runtimeEpoch: "epoch-a",
  runtimeNodeId: "runtime-a",
  harness: "codex" as const,
  adapterScopeId: "scope-a",
  vendorSessionId: "vendor-a",
};

describe("web native-history policy", () => {
  it("keys state by revision and runtime epoch rather than logical session alone", () => {
    const initial = sessionBindingIdentity(binding);
    expect(sessionBindingIdentity({ ...binding, bindingRevision: 2 })).not.toBe(initial);
    expect(sessionBindingIdentity({ ...binding, runtimeEpoch: "epoch-b" })).not.toBe(initial);
    expect(sessionBindingIdentity({ ...binding })).toBe(initial);
  });

  it("does not let recovery signals bypass the fresh Codex readiness gate", () => {
    expect(nativeHistoryInitiallyReady({ harness: "codex" })).toBe(false);
    expect(nativeHistoryInitiallyReady({ harness: "codex", nativeSummary: {} })).toBe(true);
    expect(nativeHistoryInitiallyReady({ harness: "copilot" })).toBe(true);

    const identity = sessionBindingIdentity(binding);
    expect(advanceNativeHistorySignal(null, identity, false, "reconcile")).toBeNull();

    const lifecycle = advanceNativeHistorySignal(null, identity, false, "lifecycle");
    expect(lifecycle).toEqual({ bindingIdentity: identity, generation: 1, ready: true });
    expect(advanceNativeHistorySignal(lifecycle, identity, false, "reconcile")).toEqual({
      bindingIdentity: identity,
      generation: 2,
      ready: true,
    });
  });

  it("uses only the configured bounded retries", async () => {
    const read = vi.fn()
      .mockRejectedValueOnce(rpcError("SERVICE_UNAVAILABLE", "not ready"))
      .mockRejectedValueOnce(rpcError("SERVICE_UNAVAILABLE", "still settling"))
      .mockResolvedValue("history");
    const waits: number[] = [];

    await expect(retryNativeHistory(read, {
      retryDelaysMs: [10, 20],
      wait: async (delayMs) => { waits.push(delayMs); },
    })).resolves.toBe("history");
    expect(read).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([10, 20]);
  });

  it("does not issue another retry after its binding is retired", async () => {
    let active = true;
    const read = vi.fn().mockRejectedValue(
      rpcError("SERVICE_UNAVAILABLE", "not ready"),
    );

    await expect(retryNativeHistory(read, {
      retryDelaysMs: [10, 20],
      active: () => active,
      wait: async () => { active = false; },
    })).rejects.toThrow("not ready");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("recognizes only explicit transient tRPC and transport failures", () => {
    expect(isRetryableNativeHistoryError(rpcError("SERVICE_UNAVAILABLE"))).toBe(true);
    expect(isRetryableNativeHistoryError(rpcError("TIMEOUT"))).toBe(true);
    expect(isRetryableNativeHistoryError({ cause: { code: "DISCONNECTED" } })).toBe(true);
    expect(isRetryableNativeHistoryError({ code: "UNAVAILABLE" })).toBe(true);

    expect(isRetryableNativeHistoryError(rpcError("UNAUTHORIZED"))).toBe(false);
    expect(isRetryableNativeHistoryError(rpcError("FORBIDDEN"))).toBe(false);
    expect(isRetryableNativeHistoryError(rpcError("NOT_FOUND"))).toBe(false);
    expect(isRetryableNativeHistoryError(rpcError("INTERNAL_SERVER_ERROR"))).toBe(false);
    expect(isRetryableNativeHistoryError(new Error("network-ish wording"))).toBe(false);
  });

  it.each(["UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "INTERNAL_SERVER_ERROR"])(
    "does not retry permanent %s failures",
    async (code) => {
      const error = rpcError(code, `failed with ${code}`);
      const read = vi.fn().mockRejectedValue(error);
      const wait = vi.fn<(delayMs: number) => Promise<void>>();

      await expect(retryNativeHistory(read, {
        retryDelaysMs: [10, 20],
        wait,
      })).rejects.toBe(error);
      expect(read).toHaveBeenCalledOnce();
      expect(wait).not.toHaveBeenCalled();
    },
  );

  it("honors an authoritative permanent tRPC code over a nested transient cause", () => {
    expect(isRetryableNativeHistoryError({
      data: { code: "UNAUTHORIZED" },
      cause: { code: "DISCONNECTED" },
    })).toBe(false);
  });
});

function rpcError(code: string, message = code): Error & {
  readonly data: { readonly code: string };
} {
  return Object.assign(new Error(message), { data: { code } });
}
