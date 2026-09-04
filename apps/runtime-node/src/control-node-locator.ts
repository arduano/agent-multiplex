import type { PinnedPeerTarget } from "@arduano/agent-multiplex-transport-p2prpc";
import type { RuntimeNodeStore } from "@arduano/agent-multiplex-runtime-node-core";

export const CONTROL_NODE_LOCATOR_SETTING_KEY = "p2p.control-node-locator.v3";

interface StoredControlNodeLocator {
  readonly version: 3;
  readonly endpointId: string;
  readonly ticket: string;
}

/**
 * Owns the mutable reachability half of an otherwise immutable control-node pin.
 * The configured endpoint ID always wins; only a ticket for that exact ID is
 * accepted from runtime-node state.
 */
export class PersistentControlNodeLocator {
  readonly #store: RuntimeNodeStore;
  readonly #endpointId: string;
  readonly #bootstrapTicket: string;
  #currentTicket: string;

  public constructor(store: RuntimeNodeStore, bootstrap: PinnedPeerTarget) {
    if (bootstrap.locator.kind !== "ticket") {
      throw new TypeError("runtime-node bootstrap locator must be a signed ticket");
    }
    this.#store = store;
    this.#endpointId = nonempty(bootstrap.endpointId, "control-node endpoint ID");
    this.#bootstrapTicket = nonempty(bootstrap.locator.ticket, "control-node bootstrap ticket");

    const stored = parseStoredLocator(store.getSetting(CONTROL_NODE_LOCATOR_SETTING_KEY));
    if (stored?.endpointId === this.#endpointId) {
      this.#currentTicket = stored.ticket;
    } else {
      // A stale locator for another endpoint must never influence a dial. Save
      // the configured pin and bootstrap together so the pair stays atomic.
      this.#currentTicket = this.#bootstrapTicket;
      this.#persist();
    }
  }

  public get endpointId(): string {
    return this.#endpointId;
  }

  public currentTarget(): PinnedPeerTarget {
    return target(this.#endpointId, this.#currentTicket);
  }

  public bootstrapTarget(): PinnedPeerTarget {
    return target(this.#endpointId, this.#bootstrapTicket);
  }

  public hasBootstrapFallback(): boolean {
    return this.#currentTicket !== this.#bootstrapTicket;
  }

  /** Persist a fresh locator received over an authenticated control-node RPC. */
  public acceptRenewedTicket(ticket: string): boolean {
    const normalized = nonempty(ticket, "renewed control-node ticket");
    if (normalized === this.#currentTicket) return false;
    this.#currentTicket = normalized;
    this.#persist();
    return true;
  }

  /** Commit bootstrap as current only after a fallback dial succeeds. */
  public acceptBootstrapTicket(): boolean {
    return this.acceptRenewedTicket(this.#bootstrapTicket);
  }

  #persist(): void {
    const value: StoredControlNodeLocator = {
      version: 3,
      endpointId: this.#endpointId,
      ticket: this.#currentTicket,
    };
    this.#store.setSetting(CONTROL_NODE_LOCATOR_SETTING_KEY, JSON.stringify(value));
  }
}

export interface ConnectWithBootstrapFallbackOptions<T> {
  readonly locator: PersistentControlNodeLocator;
  readonly connect: (target: PinnedPeerTarget) => Promise<T>;
  readonly onFallback?: (currentError: unknown) => void;
}

/** Try the persisted/renewed ticket first, then the configured bootstrap. */
export async function connectWithBootstrapFallback<T>(
  options: ConnectWithBootstrapFallbackOptions<T>,
): Promise<T> {
  try {
    return await options.connect(options.locator.currentTarget());
  } catch (currentError) {
    if (!options.locator.hasBootstrapFallback()) throw currentError;
    options.onFallback?.(currentError);
    try {
      const connected = await options.connect(options.locator.bootstrapTarget());
      options.locator.acceptBootstrapTicket();
      return connected;
    } catch (bootstrapError) {
      throw new AggregateError(
        [currentError, bootstrapError],
        "both the persisted and bootstrap control-node tickets failed",
      );
    }
  }
}

function parseStoredLocator(value: string | undefined): StoredControlNodeLocator | undefined {
  if (value === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  const version = Reflect.get(parsed, "version");
  const endpointId = Reflect.get(parsed, "endpointId");
  const ticket = Reflect.get(parsed, "ticket");
  if (
    version !== 3 ||
    typeof endpointId !== "string" ||
    endpointId.length === 0 ||
    typeof ticket !== "string" ||
    ticket.length === 0
  ) {
    return undefined;
  }
  return { version, endpointId, ticket };
}

function target(endpointId: string, ticket: string): PinnedPeerTarget {
  return Object.freeze({
    endpointId,
    locator: Object.freeze({ kind: "ticket" as const, ticket }),
  });
}

function nonempty(value: string, description: string): string {
  if (value.length === 0) throw new TypeError(`${description} must not be empty`);
  return value;
}
