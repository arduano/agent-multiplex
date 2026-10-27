import "node:module";
import { createRemoteJWKSet, jwtVerify, errors, type JWTVerifyGetKey } from "jose";
import type { IncomingMessage } from "node:http";

export type VerifiedAccount = Readonly<{ issuer: string; subject: string; expiresAt: number }>;
/** Exact issuer/audience verification, independent of person labels, browser
 * namespaces, relay credentials and model-provider credentials. */
export function jwtAccountVerifier(options: Readonly<{
  issuer: string; audience: string; keys: JWTVerifyGetKey;
  algorithms?: readonly string[];
}>) {
  if (!options.issuer || !options.audience) throw new TypeError("Explicit account issuer and audience required");
  const issuer = options.issuer, audience = options.audience, keys = options.keys;
  const algorithms = [...(options.algorithms ?? ["RS256", "ES256"])];
  if (!algorithms.length || algorithms.some(value => !["RS256", "ES256", "EdDSA"].includes(value))) throw new TypeError("Unsupported account signing algorithm");
  return async (token: string | undefined): Promise<VerifiedAccount | null> => {
    if (!token || token.length > 16384 || /\s/.test(token)) return null;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer, audience, algorithms, requiredClaims: ["sub", "exp", "iat"], clockTolerance: 5 });
      if (typeof payload.sub !== "string" || !payload.sub || payload.sub.length > 256) return null;
      return Object.freeze({ issuer, subject: payload.sub, expiresAt: payload.exp! * 1000 });
    } catch (error) {
      // Invalid evidence revokes admission. A failed key service is observation
      // unavailability, not proof that an existing account became invalid.
      if (error instanceof errors.JWTClaimValidationFailed || error instanceof errors.JWTExpired ||
          error instanceof errors.JWTInvalid || error instanceof errors.JWSInvalid ||
          error instanceof errors.JWSSignatureVerificationFailed || error instanceof errors.JOSEAlgNotAllowed) return null;
      throw new Error("Account verification unavailable");
    }
  };
}

export function remoteAccountKeys(url: string): JWTVerifyGetKey {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.hash) throw new TypeError("Trusted HTTPS key service required");
  return createRemoteJWKSet(parsed, { timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 600000 });
}

/** Cloudflare Access and ordinary Bearer transport. All candidates still need
 * signature verification; a trusted-looking header alone grants no authority. */
export function accountToken(request: Pick<IncomingMessage, "headers">): string | undefined {
  const candidates: string[] = [];
  const authorization = request.headers.authorization;
  if (authorization !== undefined) { if (!/^Bearer [^\s]+$/.test(authorization)) return undefined; candidates.push(authorization.slice(7)); }
  const assertion = request.headers["cf-access-jwt-assertion"];
  if (assertion !== undefined) { if (typeof assertion !== "string") return undefined; candidates.push(assertion); }
  const cookies = (request.headers.cookie ?? "").split(";").map(value => value.trim()).filter(value => value.startsWith("CF_Authorization="));
  if (cookies.length > 1) return undefined;
  if (cookies[0]) candidates.push(cookies[0].slice("CF_Authorization=".length));
  if (!candidates.length || candidates.some(value => value !== candidates[0])) return undefined;
  return candidates[0];
}
