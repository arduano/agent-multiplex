/** Only repeatable observations belong here. An admitted business mutation is
 * never an open callback and is never retried by this owner. */
export interface ObservationConnector {
  /** Release seals callbacks synchronously; its result proves actual cleanup. */
  connect<T>(input: {
    readonly key: string;
    open(signal: AbortSignal): AsyncIterable<T>;
    receive(value: T): void;
    unavailable(): void;
  }): () => void | Promise<void>;
}
export type ObservationDiagnostics = Readonly<{
  retained: number;
  opening: number;
  receiving: number;
  stopping: number;
}>;
export type ObservationOptions = Readonly<{
  maxFeeds?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  pause?: (ms: number, signal: AbortSignal) => Promise<void>;
}>;
export type RelayConfiguration =
  | Readonly<{ mode: "default" | "disabled" }>
  | Readonly<{ mode: "custom"; urls: readonly string[]; authToken?: string }>;
