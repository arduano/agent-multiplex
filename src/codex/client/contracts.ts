import type { TRPCClient } from "@trpc/client";
import type { CodexRouter } from "../server/router.js";
import type {
  CodexCaptureSnapshot,
  ThreadReadParams,
  ThreadReadResponse,
  ThreadTurnsListParams,
  ThreadTurnsListResponse,
  ThreadItemsListParams,
  ThreadItemsListResponse,
} from "../native-contracts.js";
import type { AnchorPort } from "../../client/contracts.js";
import type { ObservationConnector } from "../../transport/contracts.js";
import type { RunRef } from "../../protocol/index.js";
import type { CodexCapturedState } from "../capture-contracts.js";

/** Borrow only actual inferred read procedures. No native mutation is replayed
 * by the retained owner; applications use the original typed router for them. */
export type CodexReadClient = Readonly<{
  observation: TRPCClient<CodexRouter>["observation"];
  thread: Pick<TRPCClient<CodexRouter>["thread"], "read" | "turns" | "items">;
}>;
export type CodexPage =
  | Readonly<{ kind: "thread"; params: ThreadReadParams; result: ThreadReadResponse }>
  | Readonly<{ kind: "turns"; params: ThreadTurnsListParams; result: ThreadTurnsListResponse }>
  | Readonly<{ kind: "items"; params: ThreadItemsListParams; result: ThreadItemsListResponse }>;
export type CodexPageEvidence = Readonly<{
  key: string;
  source: "native-read";
  state: "current" | "stale";
  page: CodexPage;
}>;
export type CodexEntrySnapshot = CodexCapturedState &
  Readonly<{
    run: RunRef;
    capture: Omit<CodexCaptureSnapshot, "state"> | null;
    revision: number;
    freshness: "unobserved" | "connecting" | "current" | "unavailable";
    pinned: boolean;
  }>;
export type CodexViewSnapshot = Readonly<{
  revision: number;
  threadId: string;
  entry: CodexEntrySnapshot;
  pages: readonly (CodexPageEvidence | Readonly<{ key: string; state: "evicted" }>)[];
  read: Readonly<{ state: "idle" | "pending" | "ready" | "failed"; error?: unknown }>;
}>;
export interface CodexViewPort {
  readonly run: RunRef;
  readonly threadId: string;
  readonly anchor: AnchorPort;
  getSnapshot(): CodexViewSnapshot;
  subscribe(listener: () => void): () => void;
  commit(): () => void;
  pin(value: boolean): void;
  readThread(params?: Omit<ThreadReadParams, "threadId">): Promise<ThreadReadResponse>;
  readTurns(params?: Omit<ThreadTurnsListParams, "threadId">): Promise<ThreadTurnsListResponse>;
  readItems(params?: Omit<ThreadItemsListParams, "threadId">): Promise<ThreadItemsListResponse>;
  close(): void;
}
export type CodexClientLimits = Readonly<{
  maxEntries: number;
  maxViews: number;
  maxPages: number;
  maxPageBytes: number;
  maxCaptureBytes: number;
  maxItems: number;
  maxPendingReads: number;
}>;
export type CodexWorkspaceOptions = Readonly<{
  client: CodexReadClient;
  observations: ObservationConnector;
  limits?: Partial<CodexClientLimits>;
  /** Passive initial metadata/recent-turn read. Disable when composition already
   * supplies a baseline, or when the caller chooses its own native read mode. */
  loadInitialHistory?: boolean;
}>;
