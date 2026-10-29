import type { Json, SessionScope } from "./index.js";

/** A durable original's meaning is immutable, even after its result is known. */
export type Original = Readonly<{ scope: SessionScope; id: string; requestHash: string }>;
export type OperationState = "admitted" | "dispatched" | "unknown" | "succeeded" | "refused";
export type Receipt<Result = Json> = Original &
  Readonly<{ revision: number }> &
  (
    | Readonly<{ state: "admitted" | "dispatched" | "unknown"; result: null }>
    | Readonly<{ state: "succeeded"; result: Result }>
    | Readonly<{ state: "refused"; result: Json }>
  );
export type Settlement =
  Readonly<{ state: "unknown" }> | Readonly<{ state: "succeeded" | "refused"; result: Json }>;
