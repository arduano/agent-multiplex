import { createHmac, timingSafeEqual } from "node:crypto";
import { canonical, copy, id } from "../../../v8-session/src/contracts/validation.js";
import { target } from "../contracts/validation.js";
import type { GatewayTarget, RemoteRouteClaim, RemoteRouteVerifier } from "../contracts/types.js";

/** A small configured-peer proof adapter, not an account system or credential store.
 * The issuer must derive durable owner from its trusted Host, never browser input.
 * Peer keys are configuration only; proof tokens belong in authorization headers.
 */
export function createHmacRouteProof(options:Readonly<{issuer:string;audience:string;secret:Uint8Array;now?:()=>number}>) {
  id(options.issuer);id(options.audience);if(options.secret.byteLength!==32)throw new TypeError("A 32-byte peer key is required");
  const secret=Buffer.from(options.secret),clock=options.now??Date.now,revocation=new AbortController();
  const sign=(value:string)=>createHmac("sha256",secret).update(value).digest();
  const issue=(value:GatewayTarget,ttlMs=30000):string=>{
    if(!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>60000)throw new RangeError("Proof lifetime exceeds its bound");
    const payload=Buffer.from(canonical({version:1,issuer:options.issuer,audience:options.audience,target:target(value),expiresAt:clock()+ttlMs})).toString("base64url");
    return `Bearer v8route.${payload}.${sign(payload).toString("base64url")}`;
  };
  const verify:RemoteRouteVerifier=async authorization=>{
    if(revocation.signal.aborted||typeof authorization!=="string"||authorization.length>8192)return null;
    const parts=/^Bearer v8route\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(authorization);if(!parts)return null;
    const signature=Buffer.from(parts[2]!,"base64url"),expected=sign(parts[1]!);if(signature.length!==expected.length||!timingSafeEqual(signature,expected))return null;
    try{
      const value=JSON.parse(Buffer.from(parts[1]!,"base64url").toString("utf8")) as Record<string,unknown>;
      if(Object.keys(value).sort().join(",")!=="audience,expiresAt,issuer,target,version"||value.version!==1||value.issuer!==options.issuer||value.audience!==options.audience||!Number.isSafeInteger(value.expiresAt)||(value.expiresAt as number)<=clock()||(value.expiresAt as number)>clock()+60000)return null;
      return Object.freeze({target:copy(target(value.target)),expiresAt:value.expiresAt as number,revoked:revocation.signal}) satisfies RemoteRouteClaim;
    }catch{return null;}
  };
  return Object.freeze({issue,verify,revoke:()=>revocation.abort()});
}
