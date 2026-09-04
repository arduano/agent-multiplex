import { z } from "zod";

import {
  runtimeNodeBootIdSchema,
  runtimeNodeIdSchema,
  sessionIdSchema,
  terminalClientIdSchema,
  terminalIdSchema,
  terminalLeaseIdSchema,
  terminalLeaseRequestIdSchema,
} from "./ids.js";

const isoDateSchema = z.iso.datetime({ offset: true });

export const TERMINAL_MAX_FRAME_BYTES = 16 * 1_024;
export const TERMINAL_MAX_SCREEN_BYTES = 1_024 * 1_024;
/** Maximum retained runtime timeline; transport queues reserve equal live headroom. */
export const TERMINAL_MAX_REPLAY_ITEMS = 4_096;
export const TERMINAL_STREAM_BUFFER_ITEMS = TERMINAL_MAX_REPLAY_ITEMS * 2;

const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const base64Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Returns the decoded size only when the input is canonical RFC 4648 base64. */
function canonicalBase64DecodedBytes(value: string): number | undefined {
  if (!base64Pattern.test(value)) return undefined;
  // RFC 4648 canonical encoding requires all unused tail bits to be zero.
  // A regex alone accepts aliases such as AB== for the byte encoded by AA==.
  const tail = value.endsWith("==")
    ? value.charAt(value.length - 3)
    : value.endsWith("=")
      ? value.charAt(value.length - 2)
      : "";
  const tailIndex = tail.length === 0 ? 0 : base64Alphabet.indexOf(tail);
  if (
    (value.endsWith("==") && (tailIndex & 0x0f) !== 0) ||
    (value.endsWith("=") && (tailIndex & 0x03) !== 0)
  ) {
    return undefined;
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return value.length === 0 ? 0 : value.length / 4 * 3 - padding;
}

function base64Schema(maximumDecodedBytes: number) {
  const maximumEncodedCharacters = Math.ceil(maximumDecodedBytes / 3) * 4;
  return z.string().max(maximumEncodedCharacters).superRefine(
    (value, context) => {
      // The preceding max check records the issue, but Zod may still execute
      // this refinement. Do not run even the canonical-form scan afterward.
      if (value.length > maximumEncodedCharacters) return;
      const decodedBytes = canonicalBase64DecodedBytes(value);
      if (decodedBytes === undefined) {
        context.addIssue({ code: "custom", message: "terminal data must be canonical base64" });
        return;
      }
      if (decodedBytes > maximumDecodedBytes) {
        context.addIssue({
          code: "too_big",
          origin: "string",
          maximum: maximumDecodedBytes,
          inclusive: true,
          message: `decoded terminal data must not exceed ${maximumDecodedBytes} bytes`,
        });
      }
    },
  );
}

function utf8Base64Schema(maximumDecodedBytes: number) {
  return base64Schema(maximumDecodedBytes).superRefine((value, context) => {
    const maximumEncodedCharacters = Math.ceil(maximumDecodedBytes / 3) * 4;
    if (value.length > maximumEncodedCharacters) return;
    const decodedBytes = canonicalBase64DecodedBytes(value);
    // Zod refinements may run even when an earlier check already emitted an
    // issue. Avoid decoding or allocating for malformed and oversized input.
    if (
      decodedBytes === undefined ||
      decodedBytes > maximumDecodedBytes
    ) {
      return;
    }
    try {
      const binary = atob(value);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      context.addIssue({
        code: "custom",
        message: "terminal write data must be valid UTF-8 text",
      });
    }
  });
}

/** One immutable logical-session binding. Every terminal call is fenced by it. */
export const terminalTargetSchema = z.object({
  sessionId: sessionIdSchema,
  runtimeNodeId: runtimeNodeIdSchema,
  bindingRevision: z.number().int().positive(),
});
export type TerminalTarget = z.infer<typeof terminalTargetSchema>;

export const terminalDimensionsSchema = z.object({
  columns: z.number().int().min(2).max(1_000),
  rows: z.number().int().min(1).max(1_000),
});
export type TerminalDimensions = z.infer<typeof terminalDimensionsSchema>;

export const terminalCursorSchema = z.object({
  terminalId: terminalIdSchema,
  sequence: z.number().int().nonnegative(),
});
export type TerminalCursor = z.infer<typeof terminalCursorSchema>;

/** Safe public lease state. The bearer token is intentionally absent. */
export const terminalLeaseSummarySchema = z.object({
  terminalLeaseId: terminalLeaseIdSchema,
  terminalClientId: terminalClientIdSchema,
  expiresAt: isoDateSchema,
});
export type TerminalLeaseSummary = z.infer<typeof terminalLeaseSummarySchema>;

export const terminalDescriptorSchema = z.object({
  ...terminalTargetSchema.shape,
  runtimeNodeBootId: runtimeNodeBootIdSchema,
  terminalId: terminalIdSchema,
  backend: z.enum(["codex-remote", "copilot-ui-server", "mock"]),
  sharing: z.enum(["session", "adapterScope"]),
  foregroundSessionId: sessionIdSchema.nullable(),
  state: z.enum(["starting", "running", "exited", "error"]),
  dimensions: terminalDimensionsSchema,
  sequence: z.number().int().nonnegative(),
  lease: terminalLeaseSummarySchema.nullable(),
  capabilities: z.object({
    write: z.boolean(),
    resize: z.boolean(),
    terminate: z.boolean(),
    restart: z.boolean(),
    foregroundSwitch: z.boolean(),
  }),
  openedAt: isoDateSchema,
  updatedAt: isoDateSchema,
  exit: z.object({
    exitCode: z.number().int().nullable(),
    signal: z.number().int().nullable(),
    message: z.string().max(4_096).optional(),
  }).nullable(),
});
export type TerminalDescriptor = z.infer<typeof terminalDescriptorSchema>;

export const terminalGetInputSchema = terminalTargetSchema;
export type TerminalGetInput = z.infer<typeof terminalGetInputSchema>;

export const terminalOpenInputSchema = terminalTargetSchema.extend({
  terminalClientId: terminalClientIdSchema,
  expectedTerminalId: terminalIdSchema.optional(),
  confirmForegroundSwitch: z.boolean().default(false),
  dimensions: terminalDimensionsSchema.optional(),
});
export type TerminalOpenInput = z.infer<typeof terminalOpenInputSchema>;

export const terminalOpenResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("opened"), terminal: terminalDescriptorSchema }),
  z.object({
    status: z.literal("confirmationRequired"),
    reason: z.enum(["restart", "foregroundSwitch"]),
    terminal: terminalDescriptorSchema,
  }),
]);
export type TerminalOpenResult = z.infer<typeof terminalOpenResultSchema>;

export const terminalAttachInputSchema = terminalTargetSchema.extend({
  terminalId: terminalIdSchema,
  cursor: terminalCursorSchema.optional(),
}).superRefine((input, context) => {
  if (input.cursor !== undefined && input.cursor.terminalId !== input.terminalId) {
    context.addIssue({
      code: "custom",
      path: ["cursor", "terminalId"],
      message: "terminal cursor must identify the requested terminal",
    });
  }
});
export type TerminalAttachInput = z.infer<typeof terminalAttachInputSchema>;

const terminalOperationBaseSchema = terminalTargetSchema.extend({
  terminalId: terminalIdSchema,
  terminalClientId: terminalClientIdSchema,
});

export const terminalLeaseAcquireInputSchema = terminalOperationBaseSchema.extend({
  /** Stable across an ambiguous retry; the runtime returns the original secret. */
  requestId: terminalLeaseRequestIdSchema,
  /** Exact current lease required for a confirmed takeover. */
  forceTerminalLeaseId: terminalLeaseIdSchema.optional(),
});
export type TerminalLeaseAcquireInput = z.infer<typeof terminalLeaseAcquireInputSchema>;

export const terminalLeaseCredentialSchema = z.object({
  terminalLeaseId: terminalLeaseIdSchema,
  /** Runtime-generated secret. It must never appear in descriptors or logs. */
  token: z.string().min(32).max(512),
});
export type TerminalLeaseCredential = z.infer<typeof terminalLeaseCredentialSchema>;

export const terminalLeaseAcquireResultSchema = z.object({
  lease: terminalLeaseSummarySchema,
  credential: terminalLeaseCredentialSchema,
  nextInputSequence: z.number().int().nonnegative(),
});
export type TerminalLeaseAcquireResult = z.infer<typeof terminalLeaseAcquireResultSchema>;

export const terminalLeaseRenewInputSchema = terminalOperationBaseSchema.extend({
  credential: terminalLeaseCredentialSchema,
});
export type TerminalLeaseRenewInput = z.infer<typeof terminalLeaseRenewInputSchema>;

export const terminalLeaseRenewResultSchema = z.object({
  lease: terminalLeaseSummarySchema,
  nextInputSequence: z.number().int().nonnegative(),
});
export type TerminalLeaseRenewResult = z.infer<typeof terminalLeaseRenewResultSchema>;

export const terminalLeaseReleaseInputSchema = terminalLeaseRenewInputSchema;
export type TerminalLeaseReleaseInput = z.infer<typeof terminalLeaseReleaseInputSchema>;

export const terminalLeaseReleaseResultSchema = z.object({ released: z.literal(true) });
export type TerminalLeaseReleaseResult = z.infer<typeof terminalLeaseReleaseResultSchema>;

const terminalInputBaseSchema = terminalOperationBaseSchema.extend({
  credential: terminalLeaseCredentialSchema,
  inputSequence: z.number().int().nonnegative(),
});

export const terminalInputSchema = z.discriminatedUnion("kind", [
  terminalInputBaseSchema.extend({
    kind: z.literal("write"),
    /** One non-empty, independently decodable UTF-8 keyboard-input frame. */
    dataBase64: utf8Base64Schema(TERMINAL_MAX_FRAME_BYTES).refine(
      (value) => value.length > 0,
      "terminal write must not be empty",
    ),
  }),
  terminalInputBaseSchema.extend({
    kind: z.literal("resize"),
    dimensions: terminalDimensionsSchema,
  }),
]);
export type TerminalInput = z.infer<typeof terminalInputSchema>;

export const terminalInputResultSchema = z.object({
  terminalId: terminalIdSchema,
  inputSequence: z.number().int().nonnegative(),
  acceptedAt: isoDateSchema,
});
export type TerminalInputResult = z.infer<typeof terminalInputResultSchema>;

export const terminalTerminateInputSchema = terminalOperationBaseSchema.extend({
  /** Repeated deliberately so generic/replayed UI actions must opt into CAS. */
  expectedTerminalId: terminalIdSchema,
}).superRefine((input, context) => {
  if (input.expectedTerminalId !== input.terminalId) {
    context.addIssue({
      code: "custom",
      path: ["expectedTerminalId"],
      message: "termination CAS must match the requested terminal",
    });
  }
});
export type TerminalTerminateInput = z.infer<typeof terminalTerminateInputSchema>;

const terminalStreamItemShapeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("replayStart"),
    cursor: terminalCursorSchema.extend({ sequence: z.literal(0) }),
    initialDimensions: terminalDimensionsSchema,
    /** Current authority snapshot; replay events reconstruct its exact screen state. */
    terminal: terminalDescriptorSchema,
  }),
  z.object({
    kind: z.literal("replayEnd"),
    cursor: terminalCursorSchema,
    terminal: terminalDescriptorSchema,
  }),
  z.object({
    kind: z.literal("reset"),
    reason: z.enum(["initial", "cursorExpired", "cursorAhead"]),
    fidelity: z.literal("synthesized"),
    cursor: terminalCursorSchema,
    screenBase64: base64Schema(TERMINAL_MAX_SCREEN_BYTES),
    terminal: terminalDescriptorSchema,
  }),
  z.object({
    kind: z.literal("output"),
    cursor: terminalCursorSchema,
    dataBase64: base64Schema(TERMINAL_MAX_FRAME_BYTES).refine(
      (value) => value.length > 0,
      "terminal output must not be empty",
    ),
  }),
  z.object({
    kind: z.literal("resize"),
    cursor: terminalCursorSchema,
    dimensions: terminalDimensionsSchema,
  }),
  z.object({
    kind: z.literal("changed"),
    cursor: terminalCursorSchema,
    terminal: terminalDescriptorSchema,
  }),
  z.object({
    kind: z.literal("heartbeat"),
    cursor: terminalCursorSchema,
  }),
]);

/**
 * Descriptor-bearing frames are self-fenced. A route may additionally compare
 * the cursor with the terminal requested by its caller, but it must never need
 * to infer whether the descriptor belongs to that cursor.
 *
 * `replayStart` is the one deliberate sequence exception: its cursor marks the
 * opening state (sequence zero), while the descriptor sequence declares the
 * replay's high-water barrier. The matching `replayEnd` carries that barrier
 * as both its cursor and descriptor sequence.
 */
export const terminalStreamItemSchema = terminalStreamItemShapeSchema.superRefine(
  (item, context) => {
    if (!("terminal" in item)) return;
    if (item.terminal.terminalId !== item.cursor.terminalId) {
      context.addIssue({
        code: "custom",
        path: ["terminal", "terminalId"],
        message: "terminal stream descriptor must identify its cursor terminal",
      });
    }
    if (
      item.kind !== "replayStart" &&
      item.terminal.sequence !== item.cursor.sequence
    ) {
      context.addIssue({
        code: "custom",
        path: ["terminal", "sequence"],
        message: "terminal stream descriptor sequence must match its cursor",
      });
    }
  },
);
export type TerminalStreamItem = z.infer<typeof terminalStreamItemSchema>;
