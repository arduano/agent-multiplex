import type { Capabilities, Catalog, ControlCommand, ManagedPolicy, NativeControlCommand, NativeEvent, NativeRead, NativeReadResult, RunRef, Selection, SessionCommand } from "./types.js";
/** Installed harness policy/encoding. The lifecycle engine has no native-kind
 * registry, setting precedence or implicit fallback implementation. */
export interface NativeProtocol {
  policy(value?: unknown): ManagedPolicy;
  selection(value: unknown): Selection;
  command(value: unknown): SessionCommand;
  event(value: unknown): NativeEvent;
  nativeCommand(value: unknown): NativeControlCommand;
  read(value: unknown): NativeRead;
  readResult(run: RunRef, request: NativeRead, value: unknown): NativeReadResult;
  urgent(type: string): boolean;
  settings(type: string): boolean;
  prepare(command: ControlCommand, originalId: string): NativeControlCommand;
  controlSteps(command: ControlCommand, observed: Selection, capabilities: Capabilities): readonly ControlCommand[] | undefined;
  preflight(command: ControlCommand, observed: Selection, catalog: () => Promise<Catalog>, latest: () => Selection): Promise<void>;
}
