import type { ReactNode, AriaAttributes } from "react";
import type {
  Command,
  EntrySnapshot,
  SessionView,
  TranscriptViewPort,
} from "../client/contracts.js";
import type { FileReadPort, Preview } from "../files/contracts.js";
import type { Row } from "../history/contracts.js";
import type { Answer, CapabilityRef, Form } from "../interactions/contracts.js";
import type { AttachmentController } from "../attachments/contracts.js";
import type { ResolveFile } from "../file-links/contracts.js";

export type DiagramLease = Readonly<{ url: string; release(): void | Promise<void> }>;
/** The renderer must enforce strict security and return an image URL, never
 * application-origin HTML. It retains actual rendering until release settles. */
export type DiagramRenderer = (
  source: string,
  options: Readonly<{ securityLevel: "strict" }>,
) => Promise<DiagramLease>;
export type Media = Readonly<{ preview: Preview; label?: string }>;
export type ChatActions = Readonly<{
  /** Consumer supplies the actual typed router payload, ID and exact run.
   * snapshot.attachments is the exact confirmed draft file set to encode in
   * this payload. Rendering/reconnect never invokes this callback. */
  draft?(text: string, snapshot: EntrySnapshot): Command;
  stop?(snapshot: EntrySnapshot): Command;
  respond?(reference: CapabilityRef, answer: Answer): Promise<unknown>;
  verificationAddress?(reference: CapabilityRef): Promise<string>;
  /** Native plan authority/mode is consumer policy; proposed_plan Markdown is
   * presentation only and never calls this operation. */
  implementPlan?: Readonly<{
    available(row: Row, snapshot: EntrySnapshot): boolean;
    invoke(row: Row, snapshot: EntrySnapshot): Promise<unknown>;
  }>;
}>;
export type ChatProps = Readonly<{
  view: SessionView;
  actions: ChatActions;
  title?: string;
  theme?: "light" | "dark";
  className?: string;
  readOnly?: boolean;
  /** Slots receive current retained state, without another control store. */
  controls?: (snapshot: EntrySnapshot) => ReactNode;
  advancedControls?: (snapshot: EntrySnapshot) => ReactNode;
  files?: FileReadPort;
  /** Prepared per-entry resource owner; imports/render never upload. */
  attachments?: AttachmentController;
  media?: (row: Row) => readonly Media[];
  /** Explicit reference mapping only. A Markdown path itself grants no access. */
  markdownFiles?: Readonly<Record<string, Preview>>;
  /** Explicit preview action for a proved native row. The injected resolver
   * owns pending captures and real leases until its close/release completes. */
  resolveFile?: ResolveFile;
  renderDiagram?: DiagramRenderer;
}>;

export type ReadonlyTranscriptProps = Readonly<{
  view: TranscriptViewPort;
  title?: string;
  theme?: "light" | "dark";
  className?: string;
}> &
  Pick<ChatProps, "files" | "media" | "markdownFiles" | "resolveFile" | "renderDiagram">;

export type FilePreviewProps = Readonly<{
  descriptor: Preview;
  reader?: FileReadPort;
  label?: string;
  renderDiagram?: DiagramRenderer;
}>;
export type MarkdownProps = Readonly<{
  text: string;
  files?: Readonly<Record<string, Preview>>;
  reader?: FileReadPort;
  renderDiagram?: DiagramRenderer;
  resolveFile?: ResolveFile;
  fileContext?: Readonly<{
    run: import("../protocol/index.js").RunRef;
    stream: string;
    rowId: string;
  }>;
}>;
export type SelectOption = Readonly<{ value: string; label: string; disabled?: boolean }>;
export type SelectProps = AriaAttributes &
  Readonly<{ [key: `data-${string}`]: string | number | boolean | undefined }> &
  Readonly<{
    value: string;
    onValueChange(value: string): void;
    options: readonly SelectOption[];
    id?: string;
    disabled?: boolean;
    title?: string;
    className?: string;
  }>;
export type NativeFormValues = Record<string, string | number | boolean | readonly string[]>;
export type NativeFormProps = Readonly<{
  form: Form;
  values: NativeFormValues;
  onChange(value: NativeFormValues): void;
  errors: Readonly<Record<string, string>>;
}>;
export interface SessionSummaryReadPort {
  getSnapshot(): Pick<EntrySnapshot, "freshness" | "state" | "draft" | "attachments" | "pinned">;
  subscribe(listener: () => void): () => void;
}
export interface SessionListView {
  readonly entry: SessionSummaryReadPort;
}
export type SessionListItem<View extends SessionListView = SessionListView> = Readonly<{
  key: string;
  name: string;
  view: View;
}>;
export type SessionListProps<View extends SessionListView = SessionListView> = Readonly<{
  items: readonly SessionListItem<View>[];
  selected: View | null;
  onSelect(view: View): void;
}>;
