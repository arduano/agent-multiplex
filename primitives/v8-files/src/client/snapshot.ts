import { assertScope, type FileScope } from "../contracts/types.js";

/** Copy caller-owned routing facts synchronously, before any asynchronous work. */
export function snapshotScope(scope: FileScope): FileScope {
  const saved = { connection: scope.connection, principal: scope.principal, host: scope.host, session: scope.session };
  assertScope(saved); return Object.freeze(saved);
}
