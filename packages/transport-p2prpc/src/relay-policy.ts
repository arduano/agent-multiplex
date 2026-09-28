/** Explicit relay choice supplied by the deployment's private configuration boundary.
 * Tokens never belong in tickets, URLs, catalog records or diagnostics. */
export type MultiplexRelayPolicy =
  | { readonly mode: "default" }
  | { readonly mode: "custom"; readonly urls: readonly string[]; readonly authToken: string };
