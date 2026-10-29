/** Stable logical identity. A connection attempt or route epoch is not an owner. */
export type SessionScope = Readonly<{
  connection: string;
  principal: string;
  host: string;
  session: string;
}>;

/** The exact native lifetime; generation changes only on explicit native opening. */
export type RunRef = Readonly<{
  scope: SessionScope;
  generation: number;
  nativeSession: string;
}>;

export type Json =
  null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export const frameworkVersion = "0.8.0-alpha.0";

/** Length-delimited by JSON tuple encoding; caller-selected separators cannot
 * alias a different authenticated principal or logical conversation. */
export function scopeKey(scope: SessionScope): string {
  const values = [scope.connection, scope.principal, scope.host, scope.session];
  if (
    values.some(
      (value) =>
        typeof value !== "string" ||
        !value.length ||
        value.length > 256 ||
        /[\x00-\x1f\x7f]/.test(value),
    )
  ) {
    throw new TypeError("Invalid session scope");
  }
  return JSON.stringify(values);
}

export { closeOnAbort } from "./stream.js";
