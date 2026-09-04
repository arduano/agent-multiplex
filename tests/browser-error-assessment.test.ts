import { describe, expect, it } from "vitest";

import { assessBrowserErrors } from
  "./docker-live-four-container/browser-error-assessment.mjs";

const generic503 =
  "console.error: Failed to load resource: the server responded with a status of 503 " +
  "(Service Unavailable)";

describe("live browser receipt error assessment", () => {
  it("accepts only a native-history 503 followed by bounded recovery", () => {
    const failure = call("2026-09-03T11:41:21.593Z", 503);
    const recovery = call("2026-09-03T11:41:21.975Z", 200);

    expect(assessBrowserErrors([generic503], [failure, recovery])).toEqual({
      recoveryWindowMs: 12_500,
      recoveredTransientNativeHistoryErrors: 1,
      recoveredTransientNativeHistoryCalls: [failure],
      unrecoveredTransientNativeHistoryCalls: [],
      unexpectedBrowserErrors: [],
    });
  });

  it("keeps unrecovered, unrelated, and permanent failures fatal", () => {
    const transient = call("2026-09-03T11:41:21.593Z", 503);
    const lateRecovery = call("2026-09-03T11:41:34.094Z", 200);
    const unrelated = {
      at: "2026-09-03T11:41:21.700Z",
      path: "/trpc/sessions.search",
      status: 503,
    };
    const result = assessBrowserErrors(
      [generic503, "pageerror: permanent failure"],
      [transient, unrelated, lateRecovery],
    );

    expect(result.recoveredTransientNativeHistoryCalls).toEqual([]);
    expect(result.unrecoveredTransientNativeHistoryCalls).toEqual([transient]);
    expect(result.unexpectedBrowserErrors).toEqual([
      generic503,
      "pageerror: permanent failure",
    ]);
  });

  it("does not spend one recovery on more than one console error", () => {
    const result = assessBrowserErrors(
      [generic503, generic503],
      [
        call("2026-09-03T11:41:21.593Z", 503),
        call("2026-09-03T11:41:21.975Z", 200),
      ],
    );

    expect(result.recoveredTransientNativeHistoryErrors).toBe(1);
    expect(result.unexpectedBrowserErrors).toEqual([generic503]);
  });
});

function call(at: string, status: number) {
  return { at, path: "/trpc/sessions.readNativeHistory", status };
}
