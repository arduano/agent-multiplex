import {
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

import {
  authorityHandoffAcceptanceClaimsSchema,
  canonicalJson,
  toJsonValue,
  type AuthorityHandoffAcceptance,
  type AuthorityHandoffAcceptanceClaims,
} from "@agent-multiplex/protocol";

const ACCEPTANCE_PROOF_DOMAIN =
  "agent-multiplex/authority-handoff-acceptance/ed25519/v1\0";
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/** Host-owned signer backed by the same persistent key as its p2prpc endpoint. */
export interface AuthorityAcceptanceSigner {
  readonly endpointId: string;
  sign(claims: AuthorityHandoffAcceptanceClaims): string;
}

/**
 * Create an acceptance signer from an Iroh/p2prpc 32-byte Ed25519 secret key.
 * Its endpoint ID is derived rather than accepted as caller-controlled data.
 */
export function createP2PAuthorityAcceptanceSigner(
  secretKey: Uint8Array,
): AuthorityAcceptanceSigner {
  if (secretKey.byteLength !== 32) {
    throw new TypeError("authority acceptance Ed25519 secret key must be 32 bytes");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, Buffer.from(secretKey)]),
    format: "der",
    type: "pkcs8",
  });
  const endpointId = endpointIdForPrivateKey(privateKey);
  return Object.freeze({
    endpointId,
    sign: (claims: AuthorityHandoffAcceptanceClaims): string =>
      sign(null, authorityHandoffAcceptanceProofPayload(claims), privateKey).toString(
        "base64url",
      ),
  });
}

/** Canonical, domain-separated bytes signed by the destination authority. */
export function authorityHandoffAcceptanceProofPayload(
  claimsInput: AuthorityHandoffAcceptanceClaims,
): Buffer {
  const claims = authorityHandoffAcceptanceClaimsSchema.parse(claimsInput);
  return Buffer.from(
    `${ACCEPTANCE_PROOF_DOMAIN}${canonicalJson(toJsonValue(claims))}`,
    "utf8",
  );
}

/** Verify an acceptance against the endpoint key that the source offer names. */
export function verifyAuthorityHandoffAcceptanceProof(
  acceptance: AuthorityHandoffAcceptance,
): boolean {
  try {
    const claims = authorityHandoffAcceptanceClaimsSchema.parse(acceptance);
    const rawPublicKey = decodeEndpointId(claims.destinationAuthorityEndpointId);
    const signature = Buffer.from(acceptance.acceptanceProof.signature, "base64url");
    if (
      signature.byteLength !== 64 ||
      signature.toString("base64url") !== acceptance.acceptanceProof.signature
    ) {
      return false;
    }
    const publicKey = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      authorityHandoffAcceptanceProofPayload(claims),
      publicKey,
      signature,
    );
  } catch {
    return false;
  }
}

function endpointIdForPrivateKey(privateKey: KeyObject): string {
  const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  if (
    publicKey.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32 ||
    !publicKey.subarray(0, ED25519_SPKI_PREFIX.byteLength).equals(ED25519_SPKI_PREFIX)
  ) {
    throw new TypeError("authority acceptance key is not Ed25519");
  }
  return encodeEndpointId(publicKey.subarray(ED25519_SPKI_PREFIX.byteLength));
}

function encodeEndpointId(bytes: Uint8Array): string {
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += BASE32_ALPHABET[(buffer >> bits) & 0x1f];
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(buffer << (5 - bits)) & 0x1f];
  return output;
}

function decodeEndpointId(value: string): Buffer {
  if (value !== value.toLowerCase() || value.includes("=")) {
    throw new TypeError("p2prpc endpoint ID is not canonical lowercase base32");
  }
  const output: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of value) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) throw new TypeError("p2prpc endpoint ID is not base32");
    buffer = (buffer << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      output.push((buffer >> bits) & 0xff);
    }
  }
  const decoded = Buffer.from(output);
  if (decoded.byteLength !== 32 || encodeEndpointId(decoded) !== value) {
    throw new TypeError("p2prpc endpoint ID is not a canonical Ed25519 public key");
  }
  return decoded;
}
