import {
  TERMINAL_MAX_FRAME_BYTES,
  newRuntimeNodeId,
  newRuntimeNodeBootId,
  newSessionId,
  newTerminalClientId,
  newTerminalId,
  newTerminalLeaseId,
  terminalStreamItemSchema,
  type TerminalAttachInput,
  type TerminalInput,
  type TerminalLeaseAcquireInput,
  type TerminalStreamItem,
} from "@arduano/agent-multiplex-protocol";
import { describe, expect, it } from "vitest";

import {
  acquireTerminalKeyboard,
  terminalBase64ToBytes,
  terminalBytesToBase64,
  watchTerminal,
  type TerminalControlProcedures,
} from "../src/terminal.js";
import type {
  SubscriptionCallbacks,
  SubscriptionProcedure,
} from "../src/resilient-subscription.js";

const target = {
  sessionId: newSessionId(),
  runtimeNodeId: newRuntimeNodeId(),
  bindingRevision: 1,
};

describe("terminal client", () => {
  it("resumes from committed cursors and suppresses replayed stream items", async () => {
    const terminalId = newTerminalId();
    const procedure = new FakeTerminalSubscription();
    const received: TerminalStreamItem[] = [];
    const watcher = watchTerminal(procedure, {
      target,
      terminalId,
      onItem: (item) => received.push(item),
      initialRetryDelayMs: 0,
      maxRetryDelayMs: 0,
      retryJitter: 0,
    });
    const item = heartbeat(terminalId, 3);

    procedure.emit(item);
    await tick();
    procedure.fail(new Error("connection lost"));
    await tick();
    await tick();

    expect(procedure.inputs).toHaveLength(2);
    expect(procedure.inputs[1]?.cursor).toEqual(item.cursor);
    procedure.emit(item);
    await tick();
    expect(received).toEqual([item]);
    watcher.stop();
    await watcher.done;
  });

  it("rejects replacement terminal IDs without moving its cursor", async () => {
    const terminalId = newTerminalId();
    const procedure = new FakeTerminalSubscription();
    const watcher = watchTerminal(procedure, {
      target,
      terminalId,
      onItem: () => undefined,
      shouldRetry: () => false,
    });

    procedure.emit(heartbeat(newTerminalId(), 1));
    await expect(watcher.done).rejects.toThrow("replaced while attached");
    expect(watcher.cursor).toBeUndefined();
  });

  it("accepts a cursor-ahead reset even when it moves the local cursor backward", async () => {
    const terminalId = newTerminalId();
    const procedure = new FakeTerminalSubscription();
    const received: TerminalStreamItem[] = [];
    const watcher = watchTerminal(procedure, {
      target,
      terminalId,
      cursor: { terminalId, sequence: 99 },
      onItem: (item) => received.push(item),
      shouldRetry: () => false,
    });
    const timestamp = new Date().toISOString();
    const reset = terminalStreamItemSchema.parse({
      kind: "reset",
      reason: "cursorAhead",
      cursor: { terminalId, sequence: 3 },
      screenBase64: "",
      terminal: {
        ...target,
        runtimeNodeBootId: newRuntimeNodeBootId(),
        terminalId,
        backend: "mock",
        sharing: "session",
        foregroundSessionId: null,
        state: "running",
        dimensions: { columns: 100, rows: 30 },
        sequence: 3,
        lease: null,
        capabilities: {
          write: true,
          resize: true,
          terminate: true,
          restart: true,
          foregroundSwitch: false,
        },
        openedAt: timestamp,
        updatedAt: timestamp,
        exit: null,
      },
    });

    procedure.emit(reset);
    await tick();
    expect(received).toEqual([reset]);
    expect(watcher.cursor).toEqual(reset.cursor);
    watcher.stop();
    await watcher.done;
  });

  it("retries the exact input sequence once and keeps writes ordered", async () => {
    const terminalId = newTerminalId();
    const terminalClientId = newTerminalClientId();
    const terminalLeaseId = newTerminalLeaseId();
    const inputs: TerminalInput[] = [];
    const acquireInputs: TerminalLeaseAcquireInput[] = [];
    let firstAcquireAttempt = true;
    let firstAttempt = true;
    const procedures: TerminalControlProcedures = {
      lease: {
        acquire: { mutate: async (input) => {
          acquireInputs.push(input);
          if (firstAcquireAttempt) {
            firstAcquireAttempt = false;
            throw new Error("ambiguous acquisition response");
          }
          return {
            lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
            credential: { terminalLeaseId, token: "x".repeat(32) },
            nextInputSequence: 4,
          };
        } },
        renew: { mutate: async () => ({
          lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
          nextInputSequence: 6,
        }) },
        release: { mutate: async () => ({ released: true as const }) },
      },
      input: {
        mutate: async (input) => {
          inputs.push(input);
          if (firstAttempt) {
            firstAttempt = false;
            throw new Error("ambiguous network response");
          }
          return {
            terminalId,
            inputSequence: input.inputSequence,
            acceptedAt: new Date().toISOString(),
          };
        },
      },
    };
    const keyboard = await acquireTerminalKeyboard(procedures, {
      target,
      terminalId,
      terminalClientId,
      renewIntervalMs: 60_000,
      inputRetryDelayMs: 0,
    });

    await keyboard.write("hello");
    await keyboard.resize({ columns: 100, rows: 30 });

    expect(acquireInputs).toHaveLength(2);
    expect(acquireInputs[0]).toEqual(acquireInputs[1]);
    expect(inputs.map((input) => input.inputSequence)).toEqual([4, 4, 5]);
    expect(inputs[0]).toEqual(inputs[1]);
    expect(inputs[2]).toMatchObject({ kind: "resize", dimensions: { columns: 100, rows: 30 } });
    await keyboard.release();
    expect(keyboard.state).toEqual({ state: "released" });
  });

  it("round-trips binary terminal frames through canonical base64", () => {
    const bytes = new Uint8Array([0, 1, 127, 128, 254, 255]);
    expect(terminalBase64ToBytes(terminalBytesToBase64(bytes))).toEqual(bytes);
  });

  it("abandons an authority-revoked keyboard without a stale release RPC", async () => {
    const terminalId = newTerminalId();
    const terminalClientId = newTerminalClientId();
    const terminalLeaseId = newTerminalLeaseId();
    let releases = 0;
    const procedures: TerminalControlProcedures = {
      lease: {
        acquire: { mutate: async () => ({
          lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
          credential: { terminalLeaseId, token: "z".repeat(32) },
          nextInputSequence: 0,
        }) },
        renew: { mutate: async () => ({
          lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
          nextInputSequence: 0,
        }) },
        release: { mutate: async () => {
          releases += 1;
          return { released: true as const };
        } },
      },
      input: { mutate: async (input) => ({
        terminalId,
        inputSequence: input.inputSequence,
        acceptedAt: new Date().toISOString(),
      }) },
    };
    const keyboard = await acquireTerminalKeyboard(procedures, {
      target,
      terminalId,
      terminalClientId,
      renewIntervalMs: 60_000,
    });

    keyboard.abandon();
    await keyboard.release();

    expect(keyboard.state).toEqual({ state: "released" });
    expect(keyboard.lease).toBeUndefined();
    expect(releases).toBe(0);
    expect(() => keyboard.write("stale")).toThrow("not active");
  });

  it("chunks a UTF-8 paste at code-point boundaries without interleaving", async () => {
    const terminalId = newTerminalId();
    const terminalClientId = newTerminalClientId();
    const terminalLeaseId = newTerminalLeaseId();
    const inputs: TerminalInput[] = [];
    const procedures: TerminalControlProcedures = {
      lease: {
        acquire: { mutate: async () => ({
          lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
          credential: { terminalLeaseId, token: "y".repeat(32) },
          nextInputSequence: 0,
        }) },
        renew: { mutate: async () => ({
          lease: { terminalLeaseId, terminalClientId, expiresAt: futureDate() },
          nextInputSequence: inputs.length,
        }) },
        release: { mutate: async () => ({ released: true as const }) },
      },
      input: { mutate: async (input) => {
        inputs.push(input);
        await tick();
        return {
          terminalId,
          inputSequence: input.inputSequence,
          acceptedAt: new Date().toISOString(),
        };
      } },
    };
    const keyboard = await acquireTerminalKeyboard(procedures, {
      target,
      terminalId,
      terminalClientId,
      renewIntervalMs: 60_000,
      inputRetryDelayMs: 0,
    });

    const pasteText = `${"x".repeat(TERMINAL_MAX_FRAME_BYTES - 1)}😀`;
    const paste = keyboard.write(pasteText);
    const keypress = keyboard.write("y");
    await Promise.all([paste, keypress]);

    expect(inputs.map((input) => input.inputSequence)).toEqual([0, 1, 2]);
    const frames = inputs.map((input) => input.kind === "write"
      ? terminalBase64ToBytes(input.dataBase64)
      : new Uint8Array());
    expect(frames.map((frame) => frame.byteLength)).toEqual([
      TERMINAL_MAX_FRAME_BYTES - 1,
      4,
      1,
    ]);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    expect(frames.map((frame) => decoder.decode(frame)).join(""))
      .toBe(`${pasteText}y`);
    await keyboard.release();
  });
});

class FakeTerminalSubscription
  implements SubscriptionProcedure<TerminalAttachInput, TerminalStreamItem>
{
  readonly inputs: TerminalAttachInput[] = [];
  private callbacks: SubscriptionCallbacks<TerminalStreamItem> | undefined;

  subscribe(
    input: TerminalAttachInput,
    callbacks: SubscriptionCallbacks<TerminalStreamItem>,
  ): { unsubscribe(): void } {
    this.inputs.push(input);
    this.callbacks = callbacks;
    callbacks.onStarted?.();
    return { unsubscribe: () => undefined };
  }

  emit(item: TerminalStreamItem): void {
    this.callbacks?.onData(item);
  }

  fail(error: unknown): void {
    this.callbacks?.onError(error);
  }
}

function heartbeat(
  terminalId: ReturnType<typeof newTerminalId>,
  sequence: number,
): TerminalStreamItem {
  return terminalStreamItemSchema.parse({
    kind: "heartbeat",
    cursor: { terminalId, sequence },
  });
}

function futureDate(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
