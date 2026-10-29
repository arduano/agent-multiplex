import type { z } from "zod";
import type { Json } from "../protocol/index.js";
import type { OriginalJournalPort } from "../storage/contracts.js";
import type { NativePort, WorkspaceStrategy } from "./contracts.js";
/** The process lends one journal; the lifecycle owns its one native adapter. */
export interface LifecycleOptions<
  Input extends z.ZodType,
  Data extends z.ZodType<Json>,
  Command extends z.ZodType,
  Message extends z.ZodType = z.ZodType<Json>,
  Requested extends z.ZodType = z.ZodType<Json>,
  Observed extends z.ZodType = z.ZodType<Json>,
> {
  journal: OriginalJournalPort;
  workspace: WorkspaceStrategy<Input, Data>;
  native: NativePort<Command, Message, Requested, Observed>;
  selection: z.input<Requested>;
  maxSessions?: number;
}
