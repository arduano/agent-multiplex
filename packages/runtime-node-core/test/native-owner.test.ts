import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isNativeOwnerTerminationError,
  NativeChildProcessOwner,
  NativeOwnerTerminationError,
} from "../src/native-owner.js";

afterEach(() => { vi.useRealTimers(); });

describe("native ownership evidence", () => {
  it("finds typed evidence through causes and aggregates without matching wording", () => {
    const error = new NativeOwnerTerminationError("an arbitrary diagnostic");
    expect(error.termination).toBe("unproved");
    expect(isNativeOwnerTerminationError(new AggregateError([
      new Error("other cleanup failure"), new Error("wrapped", { cause: error }),
    ], "another arbitrary diagnostic"))).toBe(true);
    expect(isNativeOwnerTerminationError(new Error("Native child process termination was not acknowledged"))).toBe(false);
  });

  it("bounds cyclic aggregates and does not execute subclass getters", () => {
    const cycle = new AggregateError([], "cyclic");
    cycle.errors.push(cycle, new Error("wrapped", { cause: cycle }));
    expect(isNativeOwnerTerminationError(cycle)).toBe(false);
    Object.defineProperty(cycle, "cause", { get: () => { throw new Error("getter ran"); } });
    expect(isNativeOwnerTerminationError(cycle)).toBe(false);
  });
});

describe("exact native child lifetime", () => {
  it("does not treat omitted process exit fields as exit evidence", () => {
    const child = new FakeChild();
    Reflect.deleteProperty(child, "exitCode");
    Reflect.deleteProperty(child, "signalCode");
    const owner = new NativeChildProcessOwner(child.asChild());
    expect(owner.terminated).toBe(false);
    child.exit(0, null);
    expect(owner.terminated).toBe(true);
  });

  it("waits for the captured child's exit after SIGKILL, rather than its kill acknowledgement", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const owner = new NativeChildProcessOwner(child.asChild());
    const closing = owner.terminate({ graceMs: 20, forceMs: 30 });
    let complete = false;
    void closing.then(() => { complete = true; });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(20);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(complete).toBe(false);
    expect(owner.terminated).toBe(false);
    child.exit(null, "SIGKILL");
    await closing;
    expect(complete).toBe(true);
    expect(owner.terminated).toBe(true);
  });

  it("retains unproved ownership when kill fails, then recognizes a late exact exit", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const refused = new Error("signal refused");
    child.kill.mockImplementation(() => { throw refused; });
    const owner = new NativeChildProcessOwner(child.asChild());
    const closing = owner.terminate({ graceMs: 20, forceMs: 30 });
    const rejection = expect(closing).rejects.toMatchObject({
      termination: "unproved", cause: refused,
    });
    expect(owner.terminate()).toBe(closing);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
    expect(owner.terminated).toBe(false);
    child.exit(null, "SIGKILL");
    await expect(owner.terminate()).resolves.toBeUndefined();
  });

  it("does not confuse a live-child error or a different child exit with termination", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const other = new FakeChild();
    const owner = new NativeChildProcessOwner(child.asChild());
    const waiting = owner.waitForTermination(20);
    const rejection = expect(waiting).rejects.toBeInstanceOf(NativeOwnerTerminationError);
    child.emit("error", new Error("native I/O error"));
    other.exit(0, null);
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(owner.terminated).toBe(false);
    child.exit(0, null);
    expect(owner.terminated).toBe(true);
  });

  it("certifies a failed spawn only after the no-pid error event", async () => {
    const child = new FakeChild();
    child.pid = undefined;
    const owner = new NativeChildProcessOwner(child.asChild());
    expect(owner.terminated).toBe(false);
    child.emit("error", new Error("ENOENT"));
    await expect(owner.terminate()).resolves.toBeUndefined();
    expect(child.kill).not.toHaveBeenCalled();
    expect(owner.terminated).toBe(true);
  });
});

class FakeChild extends EventEmitter {
  pid: number | undefined = 42;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly kill = vi.fn((_signal: NodeJS.Signals): boolean => true);

  asChild(): ChildProcess { return this as unknown as ChildProcess; }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}
