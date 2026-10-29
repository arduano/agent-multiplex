import type { Receipt, RunRef, SessionScope } from "../protocol/index.js";
import type {
  HistoryReadPort,
  HistoryReadWindow,
  HistoryFeed,
  ReadBudgetPort,
} from "../history/contracts.js";
import type { SessionState } from "../host/contracts.js";
import type { Answer } from "../interactions/contracts.js";
import type { ConversationAnswer, ConversationInteractions } from "./contracts.js";
export interface ConversationLifecycle<NativeCommand> {
  state(scope: SessionScope): SessionState<unknown, unknown>;
  subscribe(listener: () => void): () => void;
  command(
    scope: SessionScope,
    id: string,
    command: NativeCommand,
    expectedRun: RunRef,
  ): Promise<Receipt>;
  original(scope: SessionScope, id: string): Receipt | null;
}
export type HistoryBinding = Readonly<{
  /** Exact native/Host root identity. Never rename a vendor's root stream. */
  window: HistoryReadWindow & HistoryFeed;
  port: HistoryReadPort;
  /** Optional finite cold resource. Availability is a pure owner fact; retire
   * awaits actual positive helper cleanup. It never resumes an agent. */
  resource?: Readonly<{ usable(): boolean; retire(): Promise<void> }>;
}>;
export type ConversationOptions<Command, Reply extends Answer = Answer> = Readonly<{
  lifecycle: ConversationLifecycle<Command>;
  /** Factory may obtain a native read-only lease for stopped history. It must
   * never Resume, Send or parse vendor files. Live selection must be inert;
   * actual page work belongs in port.read. Adapter/lifecycle owns native close. */
  history(
    run: RunRef,
    state: SessionState<unknown, unknown>,
  ): HistoryBinding | Promise<HistoryBinding>;
  interactions(run: RunRef): ConversationInteractions | undefined;
  encodeAnswer(input: Omit<ConversationAnswer<Reply>, "id">): Command;
  budget?: ReadBudgetPort;
  maxBindings?: number;
  waitMs?: number;
}>;
