import { copy, id } from "../../../v8-session/src/contracts/validation.js";
import { GatewayError, type GatewayTarget, type Identity, type GatewayAction } from "./types.js";
export function target(value: unknown): GatewayTarget {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GatewayError("INVALID");
  const v = value as Record<string, unknown>, keys=["connection","principal","authority","host","session","owner","routeEpoch"];
  if (Object.keys(v).length !== keys.length) throw new GatewayError("INVALID");
  try { for (const key of keys) id(v[key]); } catch { throw new GatewayError("INVALID"); }
  return copy(v as GatewayTarget);
}
export function authorized(identity: Identity, value: GatewayTarget,action:GatewayAction="read"): void {
  if (identity.connection !== value.connection || identity.principal !== value.principal || !Array.isArray(identity.authorities)||!identity.authorities.includes(value.authority)||!Array.isArray(identity.actions)||!identity.actions.includes(action)) throw new GatewayError("FORBIDDEN");
}
export function bounded(value: number, maximum: number): number { if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new GatewayError("INVALID"); return value; }
export function historyRetryToken(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !value.length || value.length > 128) throw new GatewayError('INVALID');
  return value;
}

