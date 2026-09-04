import { describe, expect, it } from "vitest";

import { browserErrorSummaryPassed } from "../scripts/native-browser-evidence.mjs";

describe("native qualification browser error evidence", () => {
  it.each([
    [0, 0],
    [1, 1],
    [3, 3],
  ])("accepts %i fully classified recoverable console errors", (raw, recovered) => {
    expect(browserErrorSummaryPassed(summary({
      browserConsoleErrors: raw,
      recoveredTransientNativeHistoryErrors: recovered,
    }))).toBe(true);
  });

  it.each([
    null,
    {},
    summary({ browserConsoleErrors: 1 }),
    summary({ browserConsoleErrors: 2, recoveredTransientNativeHistoryErrors: 1 }),
    summary({ browserConsoleErrors: -1, recoveredTransientNativeHistoryErrors: -1 }),
    summary({ browserConsoleErrors: 0.5, recoveredTransientNativeHistoryErrors: 0.5 }),
    summary({ browserConsoleErrors: 1, unexpectedBrowserErrors: 1 }),
    summary({ unrecoveredTransientNativeHistoryCalls: 1 }),
  ])("rejects incomplete or failed browser error evidence: %j", (value) => {
    expect(browserErrorSummaryPassed(value)).toBe(false);
  });
});

function summary(overrides: Record<string, unknown> = {}) {
  return {
    browserConsoleErrors: 0,
    recoveredTransientNativeHistoryErrors: 0,
    unexpectedBrowserErrors: 0,
    unrecoveredTransientNativeHistoryCalls: 0,
    ...overrides,
  };
}
