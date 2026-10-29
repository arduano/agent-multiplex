import type { StoredFile } from "../files/contracts.js";
import type { Json, Receipt, RunRef, SessionScope } from "../protocol/index.js";
import type { CallbackSink, CallbackDispatcher, CapabilityRef } from "../interactions/contracts.js";
import type { NativeObservation, NativePort } from "../host/contracts.js";
import type {
  NativeAllocationBackend,
  OpeningRef,
  OpeningCapsule,
  OpeningStopProof,
} from "../runtime/contracts.js";
import type {
  codexCommandSchema,
  codexMessageSchema,
  codexSelectionSchema,
  codexObservedSelectionSchema,
  CodexInput,
  CodexMessage,
  CodexDiagnostic,
  CodexCommand,
  CodexRead,
  CodexReadResultFor,
  CodexPrivateLoginLink,
  CodexObservedSelection,
} from "./contracts.js";
import type {
  CodexCaptureCursor,
  CodexCaptureFrame,
  CodexCaptureSnapshot,
  CodexPendingCallback,
} from "./native-contracts.js";

export type CodexProvider = Readonly<{
  id: string;
  baseUrl: string;
  environmentKey: string;
  copilotOnly: boolean;
}>;
export type CodexMcpServer = (
  | Readonly<{
      type: "stdio";
      command: string;
      args: readonly string[];
      env?: Readonly<Record<string, string>>;
    }>
  | Readonly<{ type: "http"; url: string; headers?: Readonly<Record<string, string>> }>
) &
  Readonly<{
    enabled?: boolean;
    tools?: readonly string[];
    toolApproval?: "auto" | "prompt" | "writes" | "approve";
  }>;
export type CodexStartup = Readonly<{
  provider: CodexProvider;
  model: string;
  developerInstructions?: string;
  mcpServers?: Readonly<Record<string, CodexMcpServer>>;
  multiAgent?: false | Readonly<{ maxThreads: number; maxDepth: number }>;
}>;
export interface CodexWire {
  write(line: string): Promise<void>;
  onData(listener: (chunk: string) => void): () => void;
  onClose(listener: () => void): () => void;
  close(): Promise<void>;
}
export type CodexWireFactory = (input: {
  node: string;
  launcher: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
}) => CodexWire;
export type Notification = Readonly<{ method: string; params: unknown }>;
export type ReverseRequest = Readonly<{
  id: string | number;
  method: string;
  params: unknown;
  capability: object;
  settled: Promise<void>;
  reply(value: unknown): Promise<void>;
}>;

/** Host-owned durable auxiliary custody. Model metadata does not invent a
 * native conversation RunRef: the actual resource is its OpeningRef. */
export interface CodexReaderLease {
  readonly opening: OpeningRef;
  readonly prior?: OpeningCapsule;
  begin(opening: OpeningRef): Promise<void>;
  owned(capsule: OpeningCapsule): Promise<void>;
  released(proof: OpeningStopProof): Promise<void>;
}
export type CodexReaderOptions = CodexStartup &
  Readonly<{
    node: string;
    binary: string;
    packageRoot: string;
    directory: string;
    home: string;
    cwd: string;
    environment: Readonly<Record<string, string>>;
    allocation: NativeAllocationBackend;
    wire?: CodexWireFactory;
    lifetimeMs?: number;
    media?: CodexMediaMaterializer;
  }>;
export interface CodexPreparedInputs {
  readonly inputs: readonly CodexInput[];
  release(): Promise<void>;
}
export type CodexOptions = CodexStartup &
  Readonly<{
    node: string;
    binary: string;
    packageRoot: string;
    directory: string;
    homeRoot: string;
    environment: Readonly<Record<string, string>>;
    allocation: NativeAllocationBackend;
    wire?: CodexWireFactory;
    requireCopilotOnly?: boolean;
    observe?(value: NativeObservation<CodexObservedSelection>): void;
    interactions?(run: RunRef, attachment: string): CallbackSink & CallbackDispatcher;
    diagnostic?(value: CodexDiagnostic): void;
    media?: CodexMediaMaterializer;
    prepareInputs?(input: {
      run: RunRef;
      originalId: string;
      attachments: CodexMessage["attachments"];
    }): Promise<CodexPreparedInputs>;
  }>;
export interface CodexSessionCommands {
  command(
    scope: SessionScope,
    id: string,
    command: CodexCommand,
    expectedRun: RunRef,
  ): Promise<Receipt>;
}

/** Borrowed one-connection request capability. No close/reconnect or native Stop. */
export interface CodexRequestPort {
  request(method: string, params: unknown): Promise<unknown>;
}
export type CodexNative = NativePort<
  typeof codexCommandSchema,
  typeof codexMessageSchema,
  typeof codexSelectionSchema,
  typeof codexObservedSelectionSchema
>;
/** Router reads cannot allocate, Stop or inspect private adapter configuration. */
export interface CodexControlReads {
  read<Request extends CodexRead>(
    run: RunRef,
    request: Request,
  ): Promise<CodexReadResultFor<Request>>;
  loginLink(run: RunRef, original: string): CodexPrivateLoginLink;
  requestLink(reference: CapabilityRef): string;
}
/** Borrowed native API on one already-owned run. No create/resume/Stop authority. */
export interface CodexNativeApi {
  nativeRead(run: RunRef, method: string, params: unknown): Promise<unknown>;
  observation(run: RunRef): CodexCaptureSnapshot;
  watchObservation(run: RunRef, after?: CodexCaptureCursor): AsyncIterable<CodexCaptureFrame>;
  pendingCallbacks(run: RunRef): readonly CodexPendingCallback[];
  watchCallbacks(run: RunRef): AsyncIterable<readonly CodexPendingCallback[]>;
}
export type CodexMediaInput = Readonly<{
  run: RunRef;
  attachment: string;
  stream: string;
  eventId: string;
  rowId: string;
  assetId: string;
  name: string;
  mediaType: string;
  source: Json;
}>;
export interface CodexMediaMaterializer {
  capture(input: CodexMediaInput): Promise<StoredFile>;
}
