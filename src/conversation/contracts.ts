import type { Frame, ReadObservation } from "../history/contracts.js";
import type { Answer, CapabilityRef, InteractionSnapshot } from "../interactions/contracts.js";
import type { Receipt, RunRef, SessionScope } from "../protocol/index.js";
import type { Command, SessionState } from "../client/contracts.js";
/** A pure observation projection. Native custody remains with the lifecycle. */
export type ConversationState = SessionState;
export interface ConversationInteractions {
  getSnapshot(): InteractionSnapshot;
  subscribe(listener: (snapshot: InteractionSnapshot) => void): () => void;
}
export type ConversationAnswer<Reply extends Answer = Answer> = Readonly<{
  id: string;
  reference: CapabilityRef;
  answer: Reply;
}>;
export type StreamSource<T> = AsyncIterable<T> | Promise<AsyncIterable<T>>;
/** Direct typed tRPC caller projection; browser observable subscriptions can be
 * adapted with subscriptionStream. No path strings or vendor command union. */
export interface ConversationCaller {
  stateWatch(input: { session: string }, unavailable?: () => void): StreamSource<ConversationState>;
  historyWatch(input: { run: RunRef }, unavailable?: () => void): StreamSource<Frame>;
  interactionsWatch(
    input: { run: RunRef },
    unavailable?: () => void,
  ): StreamSource<InteractionSnapshot>;
  baseline(input: { run: RunRef }): Promise<ReadObservation>;
  older(input: { run: RunRef; cursor: string }): Promise<ReadObservation>;
  original(input: { session: string; id: string }): Promise<Receipt | null>;
}
export type ConversationFeedOptions = Readonly<{
  caller(scope: SessionScope): ConversationCaller;
  dispatch(scope: SessionScope, command: Command): Promise<Receipt>;
}>;
export type SubscriptionObserver<T> = Readonly<{
  onData(value: T): void;
  onError(error: unknown): void;
  onComplete(): void;
  onConnectionStateChange(value: { state: "connecting" | "pending" | "idle" }): void;
}>;
export type SubscriptionStarter<T> = (observer: SubscriptionObserver<T>) => {
  unsubscribe(): void;
};

/** Borrowed feature service; routers cannot retire bindings or close the owner. */
export interface ConversationService<Reply extends Answer = Answer> {
  state(scope: SessionScope): ConversationState;
  stateWatch(scope: SessionScope): AsyncIterableIterator<ConversationState>;
  historyWatch(run: RunRef): AsyncIterableIterator<import("../history/contracts.js").Frame>;
  interactionsWatch(run: RunRef): AsyncIterableIterator<InteractionSnapshot>;
  baseline(run: RunRef): Promise<ReadObservation>;
  older(run: RunRef, cursor: string): Promise<ReadObservation>;
  readState(run: RunRef): Promise<import("../history/contracts.js").ReadState>;
  original(scope: SessionScope, id: string): Receipt | null;
  answer(input: ConversationAnswer<Reply>): Promise<Receipt>;
}
