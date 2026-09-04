/**
 * The browser driver may observe Chrome's generic console error for a native
 * history 503 that the UI recovers inside its bounded retry window. Require
 * every raw console error to be classified, while keeping unexpected browser
 * errors and unrecovered native-history calls fatal.
 */
export function browserErrorSummaryPassed(assertions) {
  if (assertions === null || typeof assertions !== "object") return false;

  const counts = [
    assertions.browserConsoleErrors,
    assertions.recoveredTransientNativeHistoryErrors,
    assertions.unexpectedBrowserErrors,
    assertions.unrecoveredTransientNativeHistoryCalls,
  ];
  if (!counts.every((value) => Number.isSafeInteger(value) && value >= 0)) {
    return false;
  }

  return assertions.browserConsoleErrors ===
      assertions.recoveredTransientNativeHistoryErrors +
        assertions.unexpectedBrowserErrors &&
    assertions.unexpectedBrowserErrors === 0 &&
    assertions.unrecoveredTransientNativeHistoryCalls === 0;
}
