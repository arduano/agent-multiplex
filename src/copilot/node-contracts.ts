import type { StoredFile } from "../files/contracts.js";
import type { Json, Receipt, RunRef, SessionScope } from "../protocol/index.js";
import type { NativePort, NativeObservation } from "../host/contracts.js";
import type { NativeAllocationBackend, ReaderCustodyPort } from "../runtime/contracts.js";
import type { CallbackSink, CallbackDispatcher, CapabilityRef } from "../interactions/contracts.js";
import type {
  HistoryScope,
  HistoryReadPort,
  HistoryReadWindow,
  HistoryFeed,
} from "../history/contracts.js";
import type {
  copilotCommandSchema,
  copilotMessageSchema,
  copilotSelectionSchema,
  copilotObservedSelectionSchema,
  CopilotObservedSelection,
  CopilotCommand,
  CopilotModel,
  CopilotDiagnostic,
  CopilotRead,
  CopilotReadResultFor,
  CopilotReadResult,
  CopilotLoginLink,
} from "./contracts.js";
import type { ClientFactory } from "./sdk-contracts.js";

export type CopilotOptions = Readonly<{
  binary: string;
  packageRoot: string;
  directory: string;
  homeRoot: string;
  environment: Readonly<Record<string, string>>;
  allocation: NativeAllocationBackend;
  client?: ClientFactory;
  provider: Readonly<{
    id: string;
    copilotOnly: boolean;
    config: Readonly<Record<string, Json>>;
  }>;
  requireCopilotOnly?: boolean;
  catalog?: () => Promise<readonly CopilotModel[]>;
  sessionOptions?: Readonly<Record<string, Json>>;
  prepareInputs?: (
    run: RunRef,
    ids: readonly string[],
  ) => Promise<
    Readonly<{
      attachments: readonly Json[];
      release(): Promise<void>;
    }>
  >;
  observe?: (observation: NativeObservation<CopilotObservedSelection>) => void;
  interactions?: (run: RunRef, attachment: string) => CallbackSink & Partial<CallbackDispatcher>;
  diagnostic?: (diagnostic: CopilotDiagnostic) => void;
  media?: CopilotMediaMaterializer;
  now?: () => number;
}>;
export interface CopilotLifecycle {
  command(scope: SessionScope, id: string, command: CopilotCommand, run: RunRef): Promise<Receipt>;
}

export type CopilotNative = NativePort<
  typeof copilotCommandSchema,
  typeof copilotMessageSchema,
  typeof copilotSelectionSchema,
  typeof copilotObservedSelectionSchema
>;
export interface CopilotColdHistory {
  readonly port: HistoryReadPort;
  close(): Promise<void>;
  usable(): boolean;
}
export interface CopilotControlReads {
  readForScope(scope: SessionScope, run: RunRef, input: CopilotRead): Promise<CopilotReadResult>;
}
/** One adapter owns native lifetimes and all read leases. Returned history is borrowed. */
export interface CopilotAdapter {
  readonly native: CopilotNative;
  read<Request extends CopilotRead>(
    run: RunRef,
    request: Request,
  ): Promise<CopilotReadResultFor<Request>>;
  coldHistory(
    run: RunRef,
    custody: ReaderCustodyPort,
    stream?: string,
  ): Promise<CopilotColdHistory>;
  historyScopes(run: RunRef): readonly HistoryScope[];
  history(run: RunRef, stream?: string): HistoryReadWindow & HistoryFeed;
  historyRead(run: RunRef, stream?: string): HistoryReadPort;
  loginLink(run: RunRef, original: string): CopilotLoginLink;
  callbackLink(run: RunRef, reference: CapabilityRef): string | null;
}
export type CopilotMediaInput = Readonly<{
  run: RunRef;
  attachment: string;
  eventId: string;
  stream: string;
  assetId: string;
  name: string;
  mediaType: string;
  source: Json;
}>;
export interface CopilotMediaMaterializer {
  capture(input: CopilotMediaInput): Promise<StoredFile>;
}
