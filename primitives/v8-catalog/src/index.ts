/** Browser-safe entry: no worker, SQLite, filesystem, native process, SDK or credentials. */
export * from "./contracts/types.js";
export { CatalogWorkspace } from "./client/workspace.js";
export type { LogicalEntry, LogicalView, MetadataAction } from "./client/workspace.js";
