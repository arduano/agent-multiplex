/**
 * Browser-only client surface. Keep this export list explicit: importing it
 * must not evaluate the synchronous command helpers or native p2prpc transport.
 */
export * from "./images.js";
export {
  createAccessClient,
  type AccessClient,
  type AccessClientHandle,
  type AccessClientOptions,
} from "./client.js";
export {
  advanceAccessCursor,
  watchAccess,
  type AccessWatchCursor,
  type AccessWatchHandle,
  type AccessWatchOptions,
} from "./access-watch.js";
export {
  archiveRequest,
  launchRequest,
  payloadHash,
  resumeCommand,
  sessionCommand,
  stopCommand,
} from "./browser-commands.js";
export {
  acquireTerminalKeyboard,
  advanceTerminalCursor,
  terminalBase64ToBytes,
  terminalBytesToBase64,
  watchTerminal,
  type AcquireTerminalKeyboardOptions,
  type TerminalControlProcedures,
  type TerminalKeyboardHandle,
  type TerminalKeyboardState,
  type TerminalWatchCursor,
  type TerminalWatchHandle,
  type TerminalWatchOptions,
} from "./terminal.js";
