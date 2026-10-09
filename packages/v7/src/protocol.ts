import { z } from "zod";
import {
  harnessSchema, harnessSessionSettingsSchema, jsonValueSchema, sessionRuntimeStatusSchema,
  harnessCommandSchema, harnessSpawnOptionsSchema, nativeHistoryRequestSchema,
  nativeStateRequestSchema,
  type ConversationEvidence, type Harness, type HarnessCommand, type HarnessSessionSettings,
  type HarnessSpawnOptions, type JsonValue, type NativeHistoryRequest, type NativeHistoryResult,
  type NativeModel, type NativePayload, type NativeStateRequest, type NativeStateResult,
  type SessionRuntimeStatus,
} from "@arduano/agent-multiplex-protocol";

/** V7 is a fresh generation. There is no V6 catalog/session negotiation. */
export const V7_PROTOCOL_VERSION = 7 as const;
const id = z.string().min(1).max(4_096);
export const requestStateSchema = z.enum(["admitted", "dispatched", "succeeded", "failed", "outcomeUnknown"]);
export type RequestState = z.infer<typeof requestStateSchema>;
export const requestEnvelopeSchema = z.object({ requestId: id, sessionId: id, context: jsonValueSchema.optional() }).strict();
export type RequestEnvelope = z.infer<typeof requestEnvelopeSchema>;
export const createSessionInputSchema = requestEnvelopeSchema.extend({ options: harnessSpawnOptionsSchema }).strict();
export type CreateSessionInput = z.infer<typeof createSessionInputSchema>;
export const executeInputSchema = requestEnvelopeSchema.extend({ command: harnessCommandSchema }).strict();
export type ExecuteInput = z.infer<typeof executeInputSchema>;
export const resolveInputSchema = requestEnvelopeSchema.extend({ interactionId: id, response: jsonValueSchema }).strict();
export type ResolveInput = z.infer<typeof resolveInputSchema>;
export const historyInputSchema = z.object({ sessionId: id, request: nativeHistoryRequestSchema }).strict();
export const nativeStateInputSchema = z.object({ sessionId: id, request: nativeStateRequestSchema }).strict();
export const rootCreateInputSchema = createSessionInputSchema.extend({ hostId: id, title: z.string().min(1).max(4_096) }).strict();
export const renameInputSchema = requestEnvelopeSchema.extend({ title: z.string().min(1).max(4_096) }).strict();
export const updateMetadataInputSchema = requestEnvelopeSchema.extend({ pinned: z.boolean().optional(), metadata: z.record(z.string(), jsonValueSchema).optional(),
  title: z.string().min(1).max(4_096).optional(), remove: z.array(z.string().min(1)).max(256).optional() }).strict();

export const sessionBindingSchema = z.object({
  sessionId: id, hostId: id, harness: harnessSchema, adapterScopeId: id,
  vendorSessionId: id, cwd: z.string().nullable(), createdAt: z.string(), archived: z.boolean(),
}).strict();
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
export const hostSessionSchema = sessionBindingSchema.extend({
  attachmentId: id.nullable(), status: sessionRuntimeStatusSchema,
  settings: harnessSessionSettingsSchema.optional(),
  recoveryRequired: z.boolean(),
}).strict();
export type HostSession = z.infer<typeof hostSessionSchema>;
export interface RequestReceipt {
  requestId: string; sessionId: string; operation: string; payloadHash: string;
  request: JsonValue;
  state: RequestState; result?: JsonValue; error?: { code: string; message: string };
  createdAt: string; updatedAt: string;
}
export interface SessionMetadata {
  sessionId: string; hostId: string; title: string; pinned: boolean;
  metadata: Record<string, JsonValue>; createdAt: string; archived: boolean;
}
export interface SessionView extends SessionMetadata {
  native: HostSession | null;
}
export interface HostDescriptor {
  protocolVersion: 7; hostId: string; name: string; harness: Harness; bootId: string;
}
export interface HostView extends HostDescriptor { online: boolean }
export interface RootSnapshot {
  protocolVersion: 7; rootId: string; bootId: string; revision: number;
  hosts: HostView[]; sessions: SessionView[];
}
export type RootDelta = {
  protocolVersion: 7; rootId: string; bootId: string; revision: number;
} & (
  | { kind: "host"; host: HostView }
  | { kind: "session"; session: SessionView }
);
export type RootWatchItem = { kind: "snapshot"; snapshot: RootSnapshot } | { kind: "delta"; delta: RootDelta };
export interface NativeInteraction {
  interactionId: string; nativeRequestId?: string;
  requestType: "approval" | "permission" | "userInput" | "elicitation" | "exitPlan" | "other";
  payload: NativePayload; ephemeral: boolean; expiresAt: string | null;
}
export type SessionEvent = {
  protocolVersion: 7; sessionId: string; attachmentId: string | null; sequence: number;
} & (
  | { kind: "native"; nativeType: string; payload: NativePayload; ephemeral: boolean; conversation?: ConversationEvidence }
  | { kind: "session"; session: HostSession }
  | { kind: "interaction"; interaction: NativeInteraction }
  | { kind: "interactionSettled"; interactionId: string; state: "resolved" | "expired" | "stale" }
  | { kind: "gap"; reason: string; recoveryRequired: boolean }
  | { kind: "lifecycle"; fact: JsonValue }
  | { kind: "receipt"; receipt: RequestReceipt }
);
export type HostEvent = { kind: "session"; session: HostSession } | { kind: "event"; event: SessionEvent };
export interface HistoryInput { sessionId: string; request: NativeHistoryRequest }
export interface NativeStateInput { sessionId: string; request: NativeStateRequest }
export interface SessionWatchInput { sessionId: string; attachmentId?: string | null; afterSequence?: number; signal?: AbortSignal }

/** Transport ports; no ownership, retry, catalog selection, or queue lives here. */
export interface HostApi {
  descriptor(): HostDescriptor;
  list(): HostSession[] | Promise<HostSession[]>;
  models(): Promise<NativeModel[]>;
  create(input: CreateSessionInput): Promise<RequestReceipt>;
  resume(input: RequestEnvelope): Promise<RequestReceipt>;
  stop(input: RequestEnvelope): Promise<RequestReceipt>;
  recover(input: RequestEnvelope): Promise<RequestReceipt>;
  archive(input: RequestEnvelope): Promise<RequestReceipt>;
  execute(input: ExecuteInput): Promise<RequestReceipt>;
  history(input: HistoryInput): Promise<NativeHistoryResult>;
  nativeState(input: NativeStateInput): Promise<NativeStateResult>;
  interactions(sessionId: string): NativeInteraction[] | Promise<NativeInteraction[]>;
  resolve(input: ResolveInput): Promise<RequestReceipt>;
  receipt(requestId: string): RequestReceipt | null | Promise<RequestReceipt | null>;
  watchSession(input: SessionWatchInput): AsyncIterable<SessionEvent>;
}
export interface RootCreateInput extends CreateSessionInput { hostId: string; title: string }
export interface RenameInput extends RequestEnvelope { title: string }
export interface UpdateMetadataInput extends RequestEnvelope { pinned?: boolean; metadata?: Record<string, JsonValue>; title?: string; remove?: string[] }
export interface RootApi {
  snapshot(): RootSnapshot | Promise<RootSnapshot>;
  watch(signal?: AbortSignal): AsyncIterable<RootWatchItem>;
  create(input: RootCreateInput): Promise<RequestReceipt>;
  rename(input: RenameInput): Promise<RequestReceipt>;
  updateMetadata(input: UpdateMetadataInput): Promise<RequestReceipt>;
  models(hostId: string): Promise<NativeModel[]>;
  resume(input: RequestEnvelope): Promise<RequestReceipt>;
  stop(input: RequestEnvelope): Promise<RequestReceipt>;
  recover(input: RequestEnvelope): Promise<RequestReceipt>;
  archive(input: RequestEnvelope): Promise<RequestReceipt>;
  execute(input: ExecuteInput): Promise<RequestReceipt>;
  history(input: HistoryInput): Promise<NativeHistoryResult>;
  nativeState(input: NativeStateInput): Promise<NativeStateResult>;
  interactions(sessionId: string): NativeInteraction[] | Promise<NativeInteraction[]>;
  resolve(input: ResolveInput): Promise<RequestReceipt>;
  receipt(requestId: string): RequestReceipt | null | Promise<RequestReceipt | null>;
  watchSession(input: SessionWatchInput): AsyncIterable<SessionEvent>;
}
export type { Harness, HarnessCommand, HarnessSessionSettings, HarnessSpawnOptions, JsonValue,
  NativeHistoryRequest, NativeHistoryResult, NativeModel, NativePayload, NativeStateRequest,
  NativeStateResult, SessionRuntimeStatus };
