import type { IrohEndpointOptions } from "@arduano/p2prpc-core";

/** Private, trusted process configuration. Never send these inputs to a viewer. */
export type RelayPathConfig = Readonly<{
  id: string;
  relayUrl: string;
  authToken?: string;
  /** Persist a different endpoint key per independently running path. */
  secretKey?: Uint8Array;
}>;

/** A separately published endpoint, not another candidate for one home relay. */
export type RelayPath = Readonly<{
  id: string;
  relayUrl: string;
  /** Private construction input for the pinned transport, never a public DTO. */
  endpointOptions(): IrohEndpointOptions;
}>;

const denyDirect = (_address: string): boolean => false;
const forbiddenCharacters = /[\s\p{Cc}\p{Cf}]/u;
const configKeys = new Set(["id", "relayUrl", "authToken", "secretKey"]);

function relayOrigin(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048 || forbiddenCharacters.test(input) ||
      !/^https:\/\/[^/?#\\@%]+\/?$/i.test(input)) {
    throw new TypeError("Relay URL must be an HTTPS origin");
  }
  let parsed: URL;
  try { parsed = new URL(input); }
  catch { throw new TypeError("Relay URL must be an HTTPS origin"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port === "0" ||
      parsed.pathname !== "/" || input.includes("?") || input.includes("#")) {
    throw new TypeError("Relay URL must be an HTTPS origin");
  }
  return parsed.origin;
}

/**
 * Validate without activating an endpoint, reading environment or doing network I/O.
 * Multiple custom URLs on one Iroh endpoint form a candidate pool with one home
 * relay. Concurrent independent paths require one endpoint for each returned item,
 * all exposing the same existing Host owner. This function creates no domain owner.
 */
export function normalizeRelayPaths(input: readonly RelayPathConfig[]): readonly RelayPath[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 16) {
    throw new RangeError("Configure between one and 16 relay paths");
  }
  const ids = new Set<string>(), origins = new Set<string>();
  const endpointKeys: Uint8Array[] = [];
  const paths = Array.from(input, (config): RelayPath => {
    if (config === null || typeof config !== "object" ||
        (Object.getPrototypeOf(config) !== Object.prototype && Object.getPrototypeOf(config) !== null) ||
        Reflect.ownKeys(config).some(key => typeof key !== "string" || !configKeys.has(key) ||
          !("value" in Object.getOwnPropertyDescriptor(config, key)!))) {
      throw new TypeError("Relay path configuration is invalid");
    }
    const { id, authToken } = config;
    if (typeof id !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(id)) {
      throw new TypeError("Relay path ID is invalid");
    }
    if (ids.has(id)) throw new TypeError("Relay path IDs must be unique");
    const relayUrl = relayOrigin(config.relayUrl);
    if (origins.has(relayUrl)) throw new TypeError("Relay path origins must be unique");
    if (authToken !== undefined && (typeof authToken !== "string" || authToken.length < 1 ||
        authToken.length > 8192 || forbiddenCharacters.test(authToken))) {
      throw new TypeError("Relay authentication token is invalid");
    }
    if (config.secretKey !== undefined && (!(config.secretKey instanceof Uint8Array) || config.secretKey.byteLength !== 32)) {
      throw new TypeError("Relay endpoint key must contain 32 bytes");
    }
    const secretKey = config.secretKey === undefined ? undefined : new Uint8Array(config.secretKey);
    if (secretKey !== undefined) {
      if (endpointKeys.some(key => key.every((byte, index) => byte === secretKey[index]))) {
        throw new TypeError("Relay paths must use distinct endpoint keys");
      }
      endpointKeys.push(secretKey);
    }
    ids.add(id); origins.add(relayUrl);
    // Inputs and returned option arrays cannot mutate the retained configuration.
    // A Uint8Array cannot be frozen: each endpoint receives its own defensive copy.
    const endpointOptions = (): IrohEndpointOptions => Object.freeze({
      relay: Object.freeze({ mode: "custom" as const, urls: Object.freeze([relayUrl]),
        ...(authToken === undefined ? {} : { authToken }) }),
      discovery: Object.freeze({ dns: false, mdns: false }),
      allowAdvertisedAddress: denyDirect,
      allowDirectAddress: denyDirect,
      allowRelayUrl: (origin: string) => origin === relayUrl,
      ...(secretKey === undefined ? {} : { secretKey: new Uint8Array(secretKey) }),
    });
    // Secrets stay in the closure. JSON/ordinary inspection of normalized path
    // descriptions exposes only the configured ID and noncredential origin.
    return Object.freeze({ id, relayUrl, endpointOptions });
  });
  return Object.freeze(paths);
}
