const genericServiceUnavailableConsoleError =
  "console.error: Failed to load resource: the server responded with a status of 503 " +
  "(Service Unavailable)";

/**
 * Chrome logs every non-2xx resource response even when application code
 * handles it. Match only a native-history 503 that demonstrably recovered
 * inside the UI's bounded retry window; every other console error stays fatal.
 */
export function assessBrowserErrors(browserErrors, accessCalls) {
  // retryNativeHistory has 11.5 seconds of bounded backoff. Allow one second
  // for the successful HTTP response after the last scheduled retry.
  const recoveryWindowMs = 12_500;
  const transientCalls = accessCalls.filter((call) =>
    call.path.includes("sessions.readNativeHistory") && call.status === 503
  );
  const successfulCalls = accessCalls.filter(isSuccessfulNativeHistoryCall);
  const usedSuccessfulCalls = new Set();
  const recoveredTransientNativeHistoryCalls = [];
  const unrecoveredTransientNativeHistoryCalls = [];
  for (const failure of transientCalls) {
    const failedAt = Date.parse(failure.at);
    const recovery = successfulCalls.find((candidate) => {
      if (usedSuccessfulCalls.has(candidate)) return false;
      if (failure.client !== undefined && candidate.client !== failure.client) return false;
      const recoveredAt = Date.parse(candidate.at);
      return recoveredAt >= failedAt &&
        recoveredAt - failedAt <= recoveryWindowMs;
    });
    if (recovery === undefined) {
      unrecoveredTransientNativeHistoryCalls.push(failure);
    } else {
      usedSuccessfulCalls.add(recovery);
      recoveredTransientNativeHistoryCalls.push(failure);
    }
  }
  let recoverableConsoleErrors = recoveredTransientNativeHistoryCalls.length;
  const unexpectedBrowserErrors = [];
  for (const error of browserErrors) {
    if (
      isGenericServiceUnavailableConsoleError(error) &&
      recoverableConsoleErrors > 0
    ) {
      recoverableConsoleErrors -= 1;
    } else {
      unexpectedBrowserErrors.push(error);
    }
  }

  return {
    recoveryWindowMs,
    recoveredTransientNativeHistoryErrors:
      recoveredTransientNativeHistoryCalls.length - recoverableConsoleErrors,
    recoveredTransientNativeHistoryCalls,
    unrecoveredTransientNativeHistoryCalls,
    unexpectedBrowserErrors,
  };
}

function isGenericServiceUnavailableConsoleError(error) {
  return error === genericServiceUnavailableConsoleError ||
    error === `operator ${genericServiceUnavailableConsoleError}` ||
    error === `read-only-observer ${genericServiceUnavailableConsoleError}`;
}

function isSuccessfulNativeHistoryCall(call) {
  return call.path.includes("sessions.readNativeHistory") &&
    call.status >= 200 && call.status < 300;
}
