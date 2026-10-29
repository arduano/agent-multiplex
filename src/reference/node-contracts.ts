import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
/** An explicit Node WebSocket upgrade entry. RPC framing belongs to p2prpc. */
export type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;
/** Explicit disjoint private paths; build payload is immutable and separate. */
export type MutableStatePaths = Readonly<{ agents: string; system: string }>;
export type Application = Readonly<{
  handler(request: Request): Promise<Response>;
  upgrade?: UpgradeHandler;
  close(): Promise<void> | void;
}>;
/** Importing this factory remains inert; only the CLI's run command calls it. */
export type ApplicationFactory = (
  input: Readonly<{ paths: MutableStatePaths }>,
) => Application | Promise<Application>;
export interface ApplicationModule {
  readonly create: ApplicationFactory;
}

export interface ServeOptions {
  handler(request: Request): Promise<Response>;
  upgrade?: UpgradeHandler;
  host?: string;
  port?: number;
  assets?: string;
}
export type ReferenceOptions = Readonly<{ directory: string; seed?: boolean }>;
export type StartReferenceOptions = ReferenceOptions &
  Readonly<{ assetDirectory?: string; port?: number }>;
