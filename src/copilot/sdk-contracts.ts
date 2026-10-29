import type { Json } from "../protocol/index.js";
export type Event = Readonly<{
  id: string;
  type: string;
  data: Readonly<Record<string, unknown>>;
  agentId?: string;
  parentId?: string | null;
  ephemeral?: boolean;
}>;
export type Invocation = Readonly<{
  sessionId: string;
}>;
export type SessionConfig = Readonly<Record<string, unknown>> &
  Readonly<{
    onEvent(event: unknown): void;
    onPermissionRequest(): Readonly<{
      kind: "no-result";
    }>;
    onUserInputRequest(request: unknown, invocation: Invocation): Promise<Json>;
    onExitPlanModeRequest(request: unknown, invocation: Invocation): Promise<Json>;
    onElicitationRequest(request: unknown): Promise<Json>;
  }>;
type Method = (input?: Readonly<Record<string, unknown>>) => Promise<unknown>;
export interface SdkSession {
  readonly sessionId: string;
  send(
    input: Readonly<{
      prompt: string;
      mode: "enqueue" | "immediate";
      attachments?: readonly Json[];
    }>,
  ): Promise<string>;
  abort(): Promise<void>;
  readonly rpc: Readonly<{
    model: Readonly<{
      getCurrent: Method;
      switchTo: Method;
    }>;
    mode: Readonly<{
      get: Method;
      set: Method;
    }>;
    permissions: Readonly<{
      getMode: Method;
      setMode: Method;
      setRequired: Method;
      handlePendingPermissionRequest: Method;
    }>;
    queue: Readonly<{
      pendingItems: Method;
      sendNow: Method;
    }>;
    tasks: Readonly<{
      refresh: Method;
      list: Method;
      getProgress: Method;
      getCurrentPromotable: Method;
      cancel: Method;
      promoteToBackground: Method;
    }>;
    history: Readonly<{
      compact: Method;
    }>;
    mcp: Readonly<{
      listConfigured: Method;
      restartServer: Method;
      oauth: Readonly<{
        login: Method;
      }>;
    }>;
    eventLog: Readonly<{
      read: Method;
    }>;
    metadata: Readonly<{
      activity: Method;
    }>;
  }>;
}
export interface SdkClient {
  start(): Promise<void>;
  getStatus(): Promise<
    Readonly<{
      version: string;
      protocolVersion: number;
    }>
  >;
  forceStop(): Promise<void>;
  createSession(config: SessionConfig): Promise<SdkSession>;
  resumeSession(session: string, config: SessionConfig): Promise<SdkSession>;
  listModels(): Promise<readonly unknown[]>;
  readonly rpc: Readonly<{
    sessions: Readonly<{
      readPersistedEvents: Method;
    }>;
  }>;
}
export type ClientInput = Readonly<{
  launcher: string;
  home: string;
  cwd: string;
  environment: Readonly<Record<string, string>>;
}>;
export type ClientFactory = (input: ClientInput) => Promise<SdkClient> | SdkClient;
