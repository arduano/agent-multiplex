import type { BrowserBridgePeer } from "@arduano/p2prpc-core/browser";
import type { AnyRouter } from "@trpc/server";
import type { AssetTransferMetadata } from "../../assets/contracts.js";
import type { ClientPersistence } from "../../client/contracts.js";
import type { DiagramRenderer } from "../../chat/contracts.js";
import type { ReferenceBootstrap } from "../contracts.js";
import type { Command, EntrySnapshot, SessionView } from "../../client/contracts.js";
import type { SessionScope } from "../../protocol/index.js";
import type { ChatActions, ChatProps, SelectOption } from "../../chat/contracts.js";
/** Reference controls use the consumer's actual typed router command builders.
 * There is no generic model/provider registry or union of vendor settings. */
export type ControlChoice = Readonly<{
  id: string;
  label: string;
  value: string;
  options: readonly SelectOption[];
  prepare(value: string, snapshot: EntrySnapshot): Command;
  advanced?: boolean;
  disabled?: boolean;
}>;
export type Conversation = Readonly<{
  id: string;
  name: string;
  view: SessionView;
  actions: ChatActions;
  controls?(snapshot: EntrySnapshot): readonly ControlChoice[];
}> &
  Pick<ChatProps, "files" | "media" | "markdownFiles" | "renderDiagram" | "readOnly">;
export type ConversationDescriptor = Omit<Conversation, "view"> & Readonly<{ scope: SessionScope }>;
export type ReferenceAppProps = Readonly<{
  conversations: readonly Conversation[];
  selected?: string;
  theme?: "light" | "dark";
  title?: string;
}>;

export interface ReferenceUiOptions<Router extends AnyRouter> {
  element: HTMLElement;
  bootstrap: ReferenceBootstrap;
  /** Borrow one actual Host peer across all mounted sessions. The browser
   * composition, not React or an individual conversation, owns its lifetime. */
  peer: Pick<BrowserBridgePeer<Router, AssetTransferMetadata>, "rpc" | "files">;
  persistence: ClientPersistence;
  renderDiagram?: DiagramRenderer;
  theme?: "light" | "dark";
}
