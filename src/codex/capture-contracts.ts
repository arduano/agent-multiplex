import type {
  CodexCaptureEvent,
  CodexCaptureCursor,
  Thread,
  ThreadItem,
  ThreadSettings,
  Turn,
} from "./native-contracts.js";

export type CodexCapturedItem = Readonly<{
  threadId: string;
  turnId: string;
  item: ThreadItem;
  attachment: string;
  revision: number;
  completed: boolean;
  continuity: "captured" | "partial";
}>;
export type CodexCapturedState = Readonly<{
  threads: Readonly<Record<string, Thread>>;
  settings: Readonly<Record<string, ThreadSettings>>;
  turns: readonly Readonly<{ threadId: string; turn: Turn }>[];
  items: readonly CodexCapturedItem[];
  /** Host-local reversion evidence; repeated snapshot delivery is not a new edit. */
  invalidatedThreads: Readonly<Record<string, CodexCaptureCursor>>;
  /** Actual native deltas for which this capture has no item base. */
  unbased: readonly CodexCaptureEvent[];
  omitted: boolean;
}>;
