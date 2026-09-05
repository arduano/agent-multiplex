import type { ActionScope } from "@arduano/agent-multiplex-protocol";
import {
  createSharedSecretSecurity,
  type AuthorizationContext,
  type AuthorizationResult,
  type PeerBoundSessionSecurity,
} from "@arduano/p2prpc-core";

export type MultiplexAuthorization = (
  context: AuthorizationContext,
) => Promise<AuthorizationResult> | AuthorizationResult;

export type MultiplexPeerRole =
  | "runtime-node"
  | "child-control-node"
  | "parent-control-node"
  | "access-gateway";

export interface MultiplexPeerAuthorization {
  readonly role: MultiplexPeerRole;
  /** Effective maximum scopes; meaningful only for access gateways. */
  readonly scopes: ReadonlySet<ActionScope>;
}

export interface MultiplexRoleAuthorizationOptions {
  /** Resolve only from authenticated principal and pinned endpoint enrollment. */
  readonly authorizationForPrincipal: (
    principalId: string,
    endpointId: string,
  ) => MultiplexPeerAuthorization | undefined;
  /** Open every narrow registration aperture. Disabled by default. */
  readonly allowEnrollment?: boolean;
  readonly allowRuntimeNodeEnrollment?: boolean;
  readonly allowChildControlNodeEnrollment?: boolean;
  readonly allowAccessGatewayEnrollment?: boolean;
}

export interface MultiplexSharedSecretOptions {
  /**
   * A securely provisioned secret shared by connected control nodes, runtime
   * nodes, and access gateways. p2prpc rejects fewer than 32 bytes.
   */
  readonly secret: string | Uint8Array;
  readonly sessionTtlMs?: number;
  readonly clockSkewMs?: number;
  /** Defaults to RPC-only and denies the unused file side channel. */
  readonly authorize?: MultiplexAuthorization;
}

export const authorizeMultiplexRpcOnly: MultiplexAuthorization = ({ action }) =>
  action.kind === "rpc"
    ? true
    : {
        allowed: false,
        reason: "agent-multiplex does not use p2prpc file transfer",
      };

const runtimeNodeIngressPaths = new Set([
  "ingress.runtimeNodes.register",
  "ingress.runtimeNodes.heartbeat",
  "ingress.runtimeNodes.reconcile",
  "ingress.metadata.pushOutbox",
  "ingress.events.publish",
  "ingress.interactions.publish",
]);

const childControlNodeIngressPaths = new Set([
  "ingress.controlNodes.attach",
  "ingress.controlNodes.heartbeat",
  "ingress.controlNodes.pushMetadataOutbox",
]);

const enrollmentPaths = new Set([
  "ingress.runtimeNodes.register",
  "ingress.controlNodes.attach",
  "ingress.gateways.enroll",
]);

const agentControlPaths = new Set([
  "access.sessions.refresh",
  "access.sessions.resume",
  "access.sessions.stop",
  "access.sessions.execute",
  "access.interactions.resolve",
  "access.images.beginUpload",
  "access.images.writeUpload",
  "access.images.commitUpload",
  "access.images.abortUpload",
]);

const agentLaunchPaths = new Set([
  "access.launches.create",
]);

const agentArchivePaths = new Set([
  "access.sessions.archive",
]);

const terminalViewPaths = new Set([
  "access.terminals.get",
  "access.terminals.attach",
]);

const terminalControlPaths = new Set([
  "access.terminals.open",
  "access.terminals.lease.acquire",
  "access.terminals.lease.renew",
  "access.terminals.lease.release",
  "access.terminals.input",
  "access.terminals.terminate",
]);

/**
 * Path- and procedure-aware authorization for a composite protocol-v5 control
 * node. Access gateways have no implicit authority: each mutation category
 * requires an explicit effective scope.
 */
export function createMultiplexRoleAuthorization(
  options: MultiplexRoleAuthorizationOptions,
): MultiplexAuthorization {
  return (context) => {
    if (context.action.kind !== "rpc") {
      return {
        allowed: false,
        reason: "agent-multiplex does not use the p2prpc file side channel",
      };
    }

    const { path, type } = context.action;
    const authorization = options.authorizationForPrincipal(
      context.principal.id,
      context.remotePeerId,
    );
    if (authorization === undefined) {
      const enrollmentAllowed =
        options.allowEnrollment === true ||
        (path === "ingress.runtimeNodes.register" &&
          options.allowRuntimeNodeEnrollment === true) ||
        (path === "ingress.controlNodes.attach" &&
          options.allowChildControlNodeEnrollment === true) ||
        (path === "ingress.gateways.enroll" &&
          options.allowAccessGatewayEnrollment === true);
      return enrollmentAllowed && enrollmentPaths.has(path)
        ? true
        : { allowed: false, reason: "p2prpc endpoint is not enrolled" };
    }

    let allowed = false;
    switch (authorization.role) {
      case "runtime-node":
        allowed = runtimeNodeIngressPaths.has(path);
        break;
      case "child-control-node":
        allowed = childControlNodeIngressPaths.has(path);
        break;
      case "parent-control-node":
        allowed = path.startsWith("link.");
        break;
      case "access-gateway":
        allowed =
          path === "ingress.gateways.enroll" ||
          gatewayScopeAllows(authorization.scopes, path, type);
        break;
    }

    return allowed
      ? true
      : {
          allowed: false,
          reason: `role ${authorization.role} cannot call ${path}`,
        };
  };
}

function gatewayScopeAllows(
  scopes: ReadonlySet<ActionScope>,
  path: string,
  type: "query" | "mutation" | "subscription",
): boolean {
  if (!path.startsWith("access.")) return false;
  if (path === "access.images.resolvePath") return type === "mutation" && scopes.has("read");
  if (path.startsWith("access.terminals.")) {
    if (terminalViewPaths.has(path)) {
      const expectedType = path === "access.terminals.get"
        ? "query"
        : "subscription";
      return type === expectedType &&
        (scopes.has("terminal-view") || scopes.has("terminal-control"));
    }
    return terminalControlPaths.has(path) && type === "mutation" &&
      scopes.has("terminal-control");
  }
  if (type !== "mutation") return scopes.has("read");
  if (agentLaunchPaths.has(path)) return scopes.has("agent-launch");
  if (agentArchivePaths.has(path)) return scopes.has("agent-archive");
  if (agentControlPaths.has(path)) return scopes.has("agent-control");
  if (path === "access.metadata.patch") return scopes.has("metadata-propose");
  if (path.startsWith("access.topology.")) return scopes.has("topology-admin");
  if (path.startsWith("access.authority.")) return scopes.has("authority-admin");
  return false;
}

export function createMultiplexSharedSecretSecurity(
  options: MultiplexSharedSecretOptions,
): PeerBoundSessionSecurity {
  return createSharedSecretSecurity(options.secret, {
    authorize: options.authorize ?? authorizeMultiplexRpcOnly,
    ...(options.sessionTtlMs !== undefined
      ? { sessionTtlMs: options.sessionTtlMs }
      : {}),
    ...(options.clockSkewMs !== undefined
      ? { clockSkewMs: options.clockSkewMs }
      : {}),
  });
}
