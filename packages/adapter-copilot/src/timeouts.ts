/** Caller observation budgets. Expiry never cancels a native request or grants
 * permission to replace its owner. Resolve once at the adapter boundary and
 * inject the resulting immutable policy into shared request owners. */
export interface CopilotTimeoutPolicy {
  readonly startupMs: number;
  readonly attachmentMs: number;
  readonly operationMs: number;
  readonly readMs: number;
  readonly cleanupMs: number;
}

export const STANDARD_COPILOT_TIMEOUTS: CopilotTimeoutPolicy = Object.freeze({
  startupMs: 60_000,
  attachmentMs: 15_000,
  operationMs: 15_000,
  readMs: 15_000,
  cleanupMs: 10_000,
});

/** Windows cold process creation, protected configuration preparation and SDK
 * acknowledgement can exceed the standard command budget. These limits bound
 * observation rather than the lifetime of the underlying noncancellable call. */
export const WINDOWS_COPILOT_TIMEOUTS: CopilotTimeoutPolicy = Object.freeze({
  startupMs: 180_000,
  attachmentMs: 120_000,
  operationMs: 60_000,
  readMs: 60_000,
  cleanupMs: 60_000,
});

export function resolveCopilotTimeouts(
  override?: CopilotTimeoutPolicy,
  platform: NodeJS.Platform = process.platform,
): CopilotTimeoutPolicy {
  const selected = override ?? (platform === "win32" ? WINDOWS_COPILOT_TIMEOUTS : STANDARD_COPILOT_TIMEOUTS);
  const snapshot = {} as Record<keyof CopilotTimeoutPolicy, number>;
  for (const key of Object.keys(STANDARD_COPILOT_TIMEOUTS) as Array<keyof CopilotTimeoutPolicy>) {
    const value = selected[key];
    // Read observation also belongs to CopilotAttachmentDriver, whose supported
    // budget is bounded to ten minutes. Other timers retain Node's exact cap.
    const maximum = key === "readMs" ? 600_000 : 2_147_483_647;
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      throw new TypeError(`Copilot timeout ${key} must be a positive integer no greater than ${maximum}ms`);
    }
    snapshot[key] = value;
  }
  return Object.freeze(snapshot);
}
