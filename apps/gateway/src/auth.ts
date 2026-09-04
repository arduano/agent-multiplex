import { createHash, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

import { TRPCError } from "@trpc/server";

import {
  actionScopeSchema,
  type ActionScope,
} from "@arduano/agent-multiplex-protocol";

export interface GatewayBearerCredential {
  /** The raw bearer credential. It is hashed once and never retained. */
  readonly bearerToken: string;
  /** Capabilities attributed to requests authenticated with this credential. */
  readonly scopes: readonly ActionScope[];
  /** Stable audit identity for the credential. */
  readonly subject?: string;
}

export interface GatewayAccessIdentity {
  readonly authentication: "loopback" | "bearer";
  readonly subject: string;
  /** Scopes permit requests; they never give the gateway data authority. */
  readonly scopes: readonly ActionScope[];
}

/** Context produced at the HTTP/WebSocket trust boundary. */
export interface GatewayAuthContext {
  readonly gatewayAccess: GatewayAccessIdentity;
}

export interface GatewayAuthenticator {
  readonly mode: "loopback" | "bearer";
  authenticateHttp(
    authorization: string | readonly string[] | undefined,
  ): GatewayAuthContext;
  authenticateWebSocket(
    connectionParams: Readonly<Record<string, string | undefined>> | null,
  ): GatewayAuthContext;
}

export const ALL_GATEWAY_ACTION_SCOPES = Object.freeze([
  "read",
  "agent-launch",
  "agent-archive",
  "agent-control",
  "terminal-view",
  "terminal-control",
  "metadata-propose",
  "topology-admin",
  "authority-admin",
] satisfies readonly ActionScope[]);

const MAX_BEARER_TOKEN_BYTES = 4_096;
const LOCAL_ACCESS_CONTEXT: GatewayAuthContext = Object.freeze({
  gatewayAccess: Object.freeze({
    authentication: "loopback",
    subject: "local-loopback",
    scopes: ALL_GATEWAY_ACTION_SCOPES,
  }),
});

/**
 * Creates one immutable edge authenticator. Bearer comparison uses fixed-size
 * SHA-256 digests so differently sized credentials still reach timingSafeEqual.
 */
export function createGatewayAuthenticator(
  config: GatewayBearerAuthConfig | undefined,
): GatewayAuthenticator {
  if (config === undefined) {
    return Object.freeze({
      mode: "loopback" as const,
      authenticateHttp: () => LOCAL_ACCESS_CONTEXT,
      authenticateWebSocket: () => LOCAL_ACCESS_CONTEXT,
    });
  }

  const credentials = "credentials" in config
    ? config.credentials
    : [config];
  if (credentials.length === 0) {
    throw new TypeError("gateway bearer auth requires at least one credential");
  }
  const records = credentials.map((credential) => {
    validateBearerToken(credential.bearerToken);
    const subject = credential.subject ?? "bearer-client";
    if (subject.length === 0 || subject.length > 256 || subject.trim() !== subject) {
      throw new TypeError("gateway bearer subject must contain 1 to 256 characters");
    }
    return Object.freeze({
      digest: bearerDigest(credential.bearerToken),
      context: Object.freeze({
        gatewayAccess: Object.freeze({
          authentication: "bearer" as const,
          subject,
          scopes: normalizeScopes(credential.scopes),
        }),
      }),
    });
  });
  if (new Set(records.map(({ context }) => context.gatewayAccess.subject)).size !== records.length) {
    throw new TypeError("gateway bearer credential subjects must be unique");
  }
  if (new Set(records.map(({ digest }) => digest.toString("hex"))).size !== records.length) {
    throw new TypeError("gateway bearer credentials must be unique");
  }

  const authenticate = (authorization: unknown): GatewayAuthContext => {
    const token = parseBearerAuthorization(authorization);
    const digest = bearerDigest(token ?? "");
    let match: GatewayAuthContext | undefined;
    for (const record of records) {
      if (timingSafeEqual(digest, record.digest)) match = record.context;
    }
    if (token === undefined || match === undefined) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: "Valid bearer authentication is required",
      });
    }
    return match;
  };

  return Object.freeze({
    mode: "bearer" as const,
    authenticateHttp: authenticate,
    authenticateWebSocket: (
      connectionParams: Readonly<Record<string, string | undefined>> | null,
    ) => authenticate(connectionParams?.authorization),
  });
}

export type GatewayBearerAuthConfig =
  | GatewayBearerCredential
  | { readonly credentials: readonly GatewayBearerCredential[] };

/** Authorization primitive for gateway router middleware. */
export function requireGatewayActionScope(
  context: GatewayAuthContext,
  scope: ActionScope,
): void {
  const parsedScope = actionScopeSchema.parse(scope);
  if (
    !context.gatewayAccess.scopes.includes(parsedScope) &&
    !(parsedScope === "terminal-view" &&
      context.gatewayAccess.scopes.includes("terminal-control"))
  ) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: `Gateway credential does not grant ${parsedScope}`,
    });
  }
}

/** Refuses wildcard/LAN listeners unless bearer authentication is configured. */
export function validateGatewayBindAddress(
  bindAddress: string | undefined,
  auth: GatewayBearerAuthConfig | undefined,
): void {
  if (auth !== undefined) {
    createGatewayAuthenticator(auth);
    return;
  }
  if (!isLoopbackBindAddress(bindAddress)) {
    throw new Error(
      "gateway HTTP may bind without authentication only to an explicit loopback IP address",
    );
  }
}

export function isLoopbackBindAddress(bindAddress: string | undefined): boolean {
  if (bindAddress === undefined || bindAddress.length === 0) return false;
  const address = stripIpv6Brackets(bindAddress);
  if (isIP(address) === 4) return address.startsWith("127.");
  if (isIP(address) !== 6) return false;
  const normalized = address.toLowerCase();
  return (
    normalized === "::1" ||
    /^::ffff:127(?:\.[0-9]{1,3}){3}$/.test(normalized)
  );
}

function normalizeScopes(scopes: readonly ActionScope[]): readonly ActionScope[] {
  const requested = new Set<ActionScope>();
  for (const scope of scopes) requested.add(actionScopeSchema.parse(scope));
  return Object.freeze(
    ALL_GATEWAY_ACTION_SCOPES.filter((scope) => requested.has(scope)),
  );
}

function validateBearerToken(token: string): void {
  const byteLength = Buffer.byteLength(token, "utf8");
  if (byteLength === 0 || byteLength > MAX_BEARER_TOKEN_BYTES || /\s/.test(token)) {
    throw new TypeError(
      `gateway bearer token must contain 1 to ${MAX_BEARER_TOKEN_BYTES} non-whitespace UTF-8 bytes`,
    );
  }
}

function parseBearerAuthorization(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^Bearer[ \t]+([^\s,]+)$/i.exec(value);
  if (match === null) return undefined;
  const token = match[1];
  if (
    token === undefined ||
    Buffer.byteLength(token, "utf8") > MAX_BEARER_TOKEN_BYTES
  ) return undefined;
  return token;
}

function bearerDigest(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}

function stripIpv6Brackets(address: string): string {
  return address.startsWith("[") && address.endsWith("]")
    ? address.slice(1, -1)
    : address;
}
