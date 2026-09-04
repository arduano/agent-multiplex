import { v7 as uuidv7 } from "uuid";
import { z } from "zod";

const id = <T extends string>(_name: T) => z.uuid().brand<T>();

export const sessionIdSchema = id("SessionId");
export const controlNodeIdSchema = id("ControlNodeId");
export const controlNodeBootIdSchema = id("ControlNodeBootId");
export const feedIdSchema = id("FeedId");
export const attachmentIdSchema = id("AttachmentId");
export const lineageIdSchema = id("LineageId");
export const realmIdSchema = id("RealmId");
export const authorityEpochIdSchema = id("AuthorityEpochId");
export const authorityTransitionIdSchema = id("AuthorityTransitionId");
export const topologyTransitionIdSchema = id("TopologyTransitionId");
export const runtimeNodeIdSchema = id("RuntimeNodeId");
export const runtimeNodeBootIdSchema = id("RuntimeNodeBootId");
export const launchIdSchema = id("LaunchId");
export const archiveOperationIdSchema = id("ArchiveOperationId");
export const commandIdSchema = id("CommandId");
export const operationIdSchema = id("OperationId");
export const interactionIdSchema = id("InteractionId");
export const terminalIdSchema = id("TerminalId");
export const terminalClientIdSchema = id("TerminalClientId");
export const terminalLeaseIdSchema = id("TerminalLeaseId");
export const terminalLeaseRequestIdSchema = id("TerminalLeaseRequestId");
export const runtimeEpochSchema = id("RuntimeEpoch");
export const adapterScopeIdSchema = z.string().min(1).max(256).brand<"AdapterScopeId">();

export type SessionId = z.infer<typeof sessionIdSchema>;
export type ControlNodeId = z.infer<typeof controlNodeIdSchema>;
export type ControlNodeBootId = z.infer<typeof controlNodeBootIdSchema>;
export type FeedId = z.infer<typeof feedIdSchema>;
export type AttachmentId = z.infer<typeof attachmentIdSchema>;
export type LineageId = z.infer<typeof lineageIdSchema>;
export type RealmId = z.infer<typeof realmIdSchema>;
export type AuthorityEpochId = z.infer<typeof authorityEpochIdSchema>;
export type AuthorityTransitionId = z.infer<typeof authorityTransitionIdSchema>;
export type TopologyTransitionId = z.infer<typeof topologyTransitionIdSchema>;
export type RuntimeNodeId = z.infer<typeof runtimeNodeIdSchema>;
export type RuntimeNodeBootId = z.infer<typeof runtimeNodeBootIdSchema>;
export type LaunchId = z.infer<typeof launchIdSchema>;
export type ArchiveOperationId = z.infer<typeof archiveOperationIdSchema>;
export type CommandId = z.infer<typeof commandIdSchema>;
export type OperationId = z.infer<typeof operationIdSchema>;
export type InteractionId = z.infer<typeof interactionIdSchema>;
export type TerminalId = z.infer<typeof terminalIdSchema>;
export type TerminalClientId = z.infer<typeof terminalClientIdSchema>;
export type TerminalLeaseId = z.infer<typeof terminalLeaseIdSchema>;
export type TerminalLeaseRequestId = z.infer<typeof terminalLeaseRequestIdSchema>;
export type RuntimeEpoch = z.infer<typeof runtimeEpochSchema>;
export type AdapterScopeId = z.infer<typeof adapterScopeIdSchema>;

export const newSessionId = (): SessionId => sessionIdSchema.parse(uuidv7());
export const newControlNodeId = (): ControlNodeId => controlNodeIdSchema.parse(uuidv7());
export const newControlNodeBootId = (): ControlNodeBootId =>
  controlNodeBootIdSchema.parse(uuidv7());
export const newFeedId = (): FeedId => feedIdSchema.parse(uuidv7());
export const newAttachmentId = (): AttachmentId => attachmentIdSchema.parse(uuidv7());
export const newLineageId = (): LineageId => lineageIdSchema.parse(uuidv7());
export const newRealmId = (): RealmId => realmIdSchema.parse(uuidv7());
export const newAuthorityEpochId = (): AuthorityEpochId =>
  authorityEpochIdSchema.parse(uuidv7());
export const newAuthorityTransitionId = (): AuthorityTransitionId =>
  authorityTransitionIdSchema.parse(uuidv7());
export const newTopologyTransitionId = (): TopologyTransitionId =>
  topologyTransitionIdSchema.parse(uuidv7());
export const newRuntimeNodeId = (): RuntimeNodeId => runtimeNodeIdSchema.parse(uuidv7());
export const newRuntimeNodeBootId = (): RuntimeNodeBootId =>
  runtimeNodeBootIdSchema.parse(uuidv7());
export const newLaunchId = (): LaunchId => launchIdSchema.parse(uuidv7());
export const newArchiveOperationId = (): ArchiveOperationId =>
  archiveOperationIdSchema.parse(uuidv7());
export const newCommandId = (): CommandId => commandIdSchema.parse(uuidv7());
export const newOperationId = (): OperationId => operationIdSchema.parse(uuidv7());
export const newInteractionId = (): InteractionId => interactionIdSchema.parse(uuidv7());
export const newTerminalId = (): TerminalId => terminalIdSchema.parse(uuidv7());
export const newTerminalClientId = (): TerminalClientId =>
  terminalClientIdSchema.parse(uuidv7());
export const newTerminalLeaseId = (): TerminalLeaseId =>
  terminalLeaseIdSchema.parse(uuidv7());
export const newTerminalLeaseRequestId = (): TerminalLeaseRequestId =>
  terminalLeaseRequestIdSchema.parse(uuidv7());
export const newRuntimeEpoch = (): RuntimeEpoch => runtimeEpochSchema.parse(uuidv7());
