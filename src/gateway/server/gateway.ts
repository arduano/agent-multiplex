import type { GatewayOptions } from "../node-contracts.js";
import { cloneJson, type Json } from "../../protocol/index.js";
import type { HostRoute } from "../../host/contracts.js";
import {
  GatewayError,
  type HostRegistration,
  type HostTarget,
  type GatewayRouteLease,
  hostTargetSchema,
  viewerSchema,
  type TopologyEntry,
  type Viewer,
} from "../contracts.js";

import { routeSchema, manifestSchema } from "./validation.js";
const copy = <T>(value: T): T => cloneJson(value as Json, 2097152) as T;
const sameRoute = (a: HostRoute, b: HostRoute) =>
  a.authority === b.authority &&
  a.host === b.host &&
  a.owner === b.owner &&
  a.routeEpoch === b.routeEpoch;
function viewer(value: Viewer): Viewer {
  const parsed = viewerSchema.parse(value);
  return Object.freeze({
    connection: parsed.connection,
    principal: parsed.principal,
    actions: Object.freeze(parsed.actions),
    hosts: Object.freeze(parsed.hosts),
  });
}
type Route<Transport> = {
  peer: HostRegistration<Transport>;
  topology: TopologyEntry;
  token: object;
  connected: boolean;
};

/** A routing/observation owner, not a catalog, native runtime or replay queue. */
export class Gateway<Transport> {
  readonly #routes = new Map<string, Route<Transport>>();
  readonly #requests = new Set<{
    record: Route<Transport>;
    controller: AbortController;
    retired: Promise<void>;
  }>();
  #closed = false;
  constructor(private readonly options: GatewayOptions) {
    if (!Number.isSafeInteger(options.maxRequests ?? 512) || (options.maxRequests ?? 512) < 1)
      throw new GatewayError("INVALID");
    if (
      !Number.isSafeInteger(options.staleAfterMs ?? 30000) ||
      (options.staleAfterMs ?? 30000) < 1 ||
      !Number.isSafeInteger(options.maxHosts ?? 128) ||
      (options.maxHosts ?? 128) < 1
    )
      throw new GatewayError("INVALID");
  }
  #now() {
    const value = (this.options.now ?? Date.now)();
    if (!Number.isFinite(value) || value < 0) throw new GatewayError("INVALID");
    return value;
  }
  #active() {
    if (this.#closed) throw new GatewayError("UNAVAILABLE");
  }
  /** Called only after transport/application Host authentication. Replacement
   * must be authorized again; old disconnect callbacks cannot hide the new peer. */
  registerHost(peer: HostRegistration<Transport>) {
    this.#active();
    routeSchema.parse(peer.route);
    manifestSchema.parse(cloneJson(peer.manifest as unknown as Json, 65536));
    if (!this.options.authorizePeer(peer)) throw new GatewayError("FORBIDDEN");
    if (!this.#routes.has(peer.route.host) && this.#routes.size >= (this.options.maxHosts ?? 128))
      throw new GatewayError("FULL");
    const host = peer.route.host;
    const borrowed = Object.freeze({
      route: copy(peer.route),
      manifest: copy(peer.manifest),
      transport: peer.transport,
    });
    const token = Object.freeze({}),
      record: Route<Transport> = {
        peer: borrowed,
        token,
        connected: true,
        topology: copy({
          route: peer.route,
          manifest: peer.manifest,
          state: "online",
          lastSeen: this.#now(),
        }),
      };
    const old = this.#routes.get(host);
    if (old) this.#invalidate(old);
    this.#routes.set(host, record);
    return Object.freeze({
      heartbeat: () => {
        if (this.#closed || this.#routes.get(host)?.token !== token || !record.connected)
          return false;
        record.topology = { ...record.topology, lastSeen: this.#now() };
        return true;
      },
      disconnect: () => {
        if (this.#routes.get(host)?.token === token) this.#invalidate(record);
      },
    });
  }
  topology(identity: Viewer): readonly TopologyEntry[] {
    this.#active();
    const permitted = viewer(identity),
      now = this.#now();
    if (!permitted.actions.includes("read")) throw new GatewayError("FORBIDDEN");
    return [...this.#routes.values()]
      .filter((record) => permitted.hosts.includes(record.topology.route.host))
      .map((record) =>
        copy({
          ...record.topology,
          state: !record.connected
            ? "offline"
            : now - record.topology.lastSeen > (this.options.staleAfterMs ?? 30000)
              ? "stale"
              : "online",
        }),
      );
  }
  #select(identity: Viewer, raw: HostTarget) {
    this.#active();
    const permitted = viewer(identity),
      target = hostTargetSchema.parse(copy(raw));
    if (!permitted.hosts.includes(target.route.host) || permitted.actions.length === 0)
      throw new GatewayError("FORBIDDEN");
    const record = this.#routes.get(target.route.host);
    if (!record?.connected) throw new GatewayError("UNAVAILABLE");
    if (!sameRoute(record.topology.route, target.route)) throw new GatewayError("FENCED");
    const manifest = record.topology.manifest;
    if (
      target.expected.contractId !== manifest.contractId ||
      target.expected.contractVersion !== manifest.contractVersion ||
      target.expected.compositionId !== manifest.compositionId
    )
      throw new GatewayError("FENCED");
    return {
      record,
      permitted,
      target: Object.freeze({
        route: Object.freeze(target.route),
        expected: Object.freeze(target.expected),
        ...(target.session ? { session: Object.freeze(target.session) } : {}),
      }),
    };
  }
  #invalidate(record: Route<Transport>): void {
    record.connected = false;
    for (const request of this.#requests)
      if (request.record === record) request.controller.abort(new GatewayError("FENCED"));
  }
  /** Lease one borrowed transport. Application protocol framing and Host
   * procedures belong to that transport, not to the Gateway. */
  acquire(identity: Viewer, raw: HostTarget): GatewayRouteLease<Transport> {
    const { record, permitted, target } = this.#select(identity, raw);
    if (this.#requests.size >= (this.options.maxRequests ?? 512)) throw new GatewayError("FULL");
    let released = false,
      retire!: () => void;
    const request = {
      record,
      controller: new AbortController(),
      retired: new Promise<void>((resolve) => {
        retire = resolve;
      }),
    };
    this.#requests.add(request);
    return Object.freeze({
      transport: record.peer.transport,
      manifest: copy(record.peer.manifest),
      viewer: permitted,
      target,
      signal: request.controller.signal,
      release: () => {
        if (released) return;
        released = true;
        this.#requests.delete(request);
        retire();
      },
    });
  }
  readiness(): boolean {
    return this.#requests.size === 0;
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const record of this.#routes.values()) record.connected = false;
    const requests = [...this.#requests];
    for (const request of requests) request.controller.abort(new GatewayError("FENCED"));
    await Promise.all(requests.map((request) => request.retired));
  }
}
