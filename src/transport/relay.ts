import type { RelayConfiguration } from "./contracts.js";
export type { RelayConfiguration } from "./contracts.js";
/** Reachability is separate from endpoint identity and application grants.
 * Credentials are startup-only values, never ticket/query/log fields. */
export function relayConfiguration(input: RelayConfiguration): RelayConfiguration {
  if (!input || !["default", "disabled", "custom"].includes(input.mode))
    throw new TypeError("Invalid relay mode");
  if (input.mode !== "custom") {
    if (Object.keys(input).some((key) => key !== "mode"))
      throw new TypeError("Unexpected relay configuration");
    return Object.freeze({ mode: input.mode });
  }
  if (
    !Array.isArray(input.urls) ||
    input.urls.length < 1 ||
    input.urls.length > 16 ||
    Object.keys(input).some((key) => !["mode", "urls", "authToken"].includes(key))
  )
    throw new TypeError("Invalid custom relay set");
  const urls = input.urls.map((value) => {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    )
      throw new TypeError("Expected an HTTPS relay origin");
    return url.origin;
  });
  if (
    new Set(urls).size !== urls.length ||
    (input.authToken !== undefined &&
      (!input.authToken ||
        input.authToken.length > 4096 ||
        /[\x00-\x1f\x7f]/.test(input.authToken)))
  )
    throw new TypeError("Invalid relay configuration");
  return Object.freeze({
    mode: "custom",
    urls: Object.freeze(urls),
    ...(input.authToken === undefined ? {} : { authToken: input.authToken }),
  });
}
