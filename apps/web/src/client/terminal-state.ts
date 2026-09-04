import type {
  Harness,
  RuntimeNodeDescriptor,
  TerminalDescriptor,
  TerminalDimensions,
  TerminalLeaseSummary,
  TerminalStreamItem,
} from "@arduano/agent-multiplex-protocol";

export interface TerminalSideChannelCapability {
  readonly experimental: boolean;
}

/**
 * Three-state capability lookup: undefined means the runtime catalog has not
 * resolved yet, null means it resolved without terminal support, and an object
 * means terminal RPCs may be attempted.
 */
export function terminalSideChannelCapability(
  runtime: RuntimeNodeDescriptor | undefined,
  harness: Harness,
): TerminalSideChannelCapability | null | undefined {
  if (!runtime) return undefined;
  const capability = runtime.harnesses
    .find((entry) => entry.harness === harness)
    ?.capabilities.find((candidate) =>
      candidate.name === "terminal.side-channel" && candidate.version === "v1"
    );
  return capability ? { experimental: capability.experimental } : null;
}

export function shouldQueryTerminal(
  active: boolean,
  capability: TerminalSideChannelCapability | null | undefined,
): boolean {
  return active && capability !== null && capability !== undefined;
}

/**
 * Reconciles a query snapshot with the subscribed descriptor without allowing
 * a late query response to revive an older terminal or regress its sequence.
 */
export function reconcileTerminalDescriptor(
  queried: TerminalDescriptor | null,
  streamed: TerminalDescriptor | null,
): TerminalDescriptor | null {
  if (!streamed) return queried;
  if (!queried) return streamed;
  if (queried.terminalId === streamed.terminalId) {
    return queried.sequence > streamed.sequence ? queried : streamed;
  }
  const queryOpenedAt = Date.parse(queried.openedAt);
  const streamOpenedAt = Date.parse(streamed.openedAt);
  if (queryOpenedAt !== streamOpenedAt) {
    return queryOpenedAt > streamOpenedAt ? queried : streamed;
  }
  return queried.updatedAt > streamed.updatedAt ? queried : streamed;
}

/** Merge only lease state, preserving the newest lifecycle/output descriptor. */
export function mergeTerminalLease(
  descriptor: TerminalDescriptor | null,
  terminalId: TerminalDescriptor["terminalId"],
  lease: TerminalLeaseSummary | null,
): TerminalDescriptor | null {
  return descriptor?.terminalId === terminalId
    ? { ...descriptor, lease }
    : descriptor;
}

export interface TerminalReplayViewState {
  readonly ready: boolean;
  readonly dimensions: TerminalDimensions;
  readonly terminal: TerminalDescriptor | null;
}

/**
 * Tracks only the descriptor/dimension effects of terminal replay. The current
 * descriptor carried by replayStart is deliberately withheld until replayEnd:
 * applying its final dimensions before historical output would change wrapping.
 */
export function reduceTerminalReplayView(
  state: TerminalReplayViewState,
  item: TerminalStreamItem,
): TerminalReplayViewState {
  if (item.kind === "replayStart") {
    return {
      ready: false,
      dimensions: { ...item.initialDimensions },
      terminal: state.terminal,
    };
  }
  if (item.kind === "replayEnd" || item.kind === "reset") {
    return {
      ready: true,
      dimensions: { ...item.terminal.dimensions },
      terminal: item.terminal,
    };
  }
  if (item.kind === "resize") {
    return { ...state, dimensions: { ...item.dimensions } };
  }
  if (item.kind === "changed") {
    return {
      ...state,
      dimensions: { ...item.terminal.dimensions },
      terminal: item.terminal,
    };
  }
  return state;
}
