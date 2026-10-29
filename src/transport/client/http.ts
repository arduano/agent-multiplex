import type { HostTarget } from "../../gateway/contracts.js";

/** Bridge routing metadata is separate from actual Host tRPC inputs. */
export function bridgeHostUrl(baseUrl: string, target: HostTarget): string {
  const url = new URL("/host", baseUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol !== "ws:" && url.protocol !== "wss:")
    throw new TypeError("Invalid bridge URL");
  url.searchParams.set("target", JSON.stringify(target));
  return url.href;
}
