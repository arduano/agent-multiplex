import { describe, expect, it } from "vitest";

import {
  pendingInteractionRefetchInterval,
  pendingInteractionRefreshIntervalMs,
} from "../apps/web/src/client/interaction-refresh.js";

describe("web pending-interaction recovery", () => {
  it("polls only while one session is selected", () => {
    expect(pendingInteractionRefetchInterval(null)).toBe(false);
    expect(pendingInteractionRefetchInterval(undefined)).toBe(false);
    expect(pendingInteractionRefetchInterval("session-a")).toBe(
      pendingInteractionRefreshIntervalMs,
    );
  });

  it("uses a low-frequency bounded cadence", () => {
    expect(pendingInteractionRefreshIntervalMs).toBeGreaterThanOrEqual(5_000);
    expect(pendingInteractionRefreshIntervalMs).toBeLessThanOrEqual(10_000);
  });
});
