import { adapterScopeIdSchema, newRuntimeNodeBootId, newRuntimeNodeId,
  newCommandId, newLaunchId, newRuntimeEpoch, newSessionId, newTerminalClientId,
  newTerminalLeaseId, newTerminalLeaseRequestId,
  type AdapterScopeId, type Harness, type SessionId } from "@arduano/agent-multiplex-protocol";
import {
  RuntimeNodeService,
  RuntimeNodeStore,
  TerminalBroker,
  TerminalSubscriberOverflowError,
  sanitizedTerminalEnvironment,
  terminalProcessFromPty,
  type AdapterSession,
  type AgentAdapter,
  type TerminalBinding,
  type TerminalProcess,
  type TerminalProcessExit,
  type TerminalProvider,
  type TerminalProviderOpenRequest,
} from "@arduano/agent-multiplex-runtime-node-core";
import type { IDisposable, IPty } from "node-pty";
import { describe, expect, it } from "vitest";

class FakeProcess implements TerminalProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ columns: number; rows: number }> = [];
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(exit: TerminalProcessExit) => void>();
  kills = 0;

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void { this.writes.push(data); }
  resize(dimensions: { columns: number; rows: number }): void {
    this.resizes.push(dimensions);
  }
  kill(): void { this.kills += 1; }
  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
  exit(exit: TerminalProcessExit = { exitCode: 0, signal: null }): void {
    for (const listener of [...this.exitListeners]) listener(exit);
  }
}

class FakeProvider implements TerminalProvider {
  readonly harness = "codex" as const;
  readonly backend = "mock" as const;
  readonly sharing = "session" as const;
  readonly capabilities = {
    write: true,
    resize: true,
    terminate: true,
    restart: true,
    foregroundSwitch: false,
  } as const;
  readonly opened: FakeProcess[] = [];

  constructor(readonly adapterScopeId: AdapterScopeId) {}

  async open(): Promise<TerminalProcess> {
    const process = new FakeProcess();
    this.opened.push(process);
    return process;
  }

  async close(): Promise<void> {}
}

function fixture(options: { subscriberItemLimit?: number; leaseTtlMs?: number;
  maxRunningTerminals?: number; replayByteLimit?: number } = {}) {
  const adapterScopeId = adapterScopeIdSchema.parse("codex:test");
  const provider = new FakeProvider(adapterScopeId);
  const runtimeNodeId = newRuntimeNodeId();
  const broker = new TerminalBroker({
    runtimeNodeBootId: newRuntimeNodeBootId(),
    providers: [provider],
    ...options,
  });
  const binding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
  return { broker, provider, binding, runtimeNodeId, adapterScopeId };
}

function bindingFor(
  sessionId: SessionId,
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>,
  adapterScopeId: AdapterScopeId,
): TerminalBinding {
  return bindingForHarness("codex", sessionId, runtimeNodeId, adapterScopeId);
}

function bindingForHarness(
  harness: Harness,
  sessionId: SessionId,
  runtimeNodeId: ReturnType<typeof newRuntimeNodeId>,
  adapterScopeId: AdapterScopeId,
): TerminalBinding {
  return {
    target: { sessionId, runtimeNodeId, bindingRevision: 1 },
    harness,
    adapterScopeId,
    vendorSessionId: `native-${sessionId}`,
    cwd: "/tmp",
  };
}

describe("TerminalBroker", () => {
  it("supports many viewers and one retry-safe keyboard lease", async () => {
    const { broker, provider, binding } = fixture();
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    const first = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    const second = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await first.next()).value?.kind).toBe("reset");
    expect((await second.next()).value?.kind).toBe("reset");

    provider.opened[0]!.emit("hello\r\n");
    expect(await first.next()).toMatchObject({ value: { kind: "output" }, done: false });
    expect(await second.next()).toMatchObject({ value: { kind: "output" }, done: false });

    const terminalClientId = newTerminalClientId();
    const requestId = newTerminalLeaseRequestId();
    const acquisition = { ...binding.target, terminalId, terminalClientId, requestId };
    const lease = broker.acquire(acquisition);
    expect(broker.acquire(acquisition)).toEqual(lease);
    expect(() => broker.acquire({ ...acquisition, terminalClientId: newTerminalClientId() }))
      .toThrow("request ID was reused");

    const input = {
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
      inputSequence: 0,
      kind: "write" as const,
      dataBase64: Buffer.from("typed once").toString("base64"),
    };
    const receipt = broker.input(input);
    expect(broker.input(input)).toEqual(receipt);
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      inputSequence: 1,
      dataBase64: Buffer.from([0xf0, 0x9f]).toString("base64"),
    })).toThrow("valid UTF-8 text");
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      inputSequence: 1,
      // Exercise the runtime boundary as an untyped JavaScript caller. Node's
      // Buffer.from silently accepts this unless the broker checks first.
      dataBase64: new Uint8Array([0x41, 0x41, 0x3d, 0x3d]),
    } as unknown as Parameters<TerminalBroker["input"]>[0])).toThrow("base64 string");
    expect(provider.opened[0]!.writes).toEqual(["typed once"]);
    expect(() => broker.input({
      ...input,
      dataBase64: Buffer.from("different").toString("base64"),
    })).toThrow("sequence was reused");

    expect(broker.renew({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    }).nextInputSequence).toBe(1);
    expect(broker.release({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    })).toEqual({ released: true });
    expect(() => broker.renew({
      ...binding.target,
      terminalId,
      terminalClientId,
      credential: lease.credential,
    })).toThrow("absent or expired");

    await first.return?.();
    await second.return?.();
    await broker.close();
  });

  it("requires an exact lease CAS for takeover and expires leases", async () => {
    const { broker, binding } = fixture({ leaseTtlMs: 20 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    const owner = newTerminalClientId();
    const first = broker.acquire({
      ...binding.target, terminalId, terminalClientId: owner,
      requestId: newTerminalLeaseRequestId(),
    });
    const contender = newTerminalClientId();
    expect(() => broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(),
    })).toThrow("already leased");
    expect(() => broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(), forceTerminalLeaseId: newTerminalLeaseId(),
    })).toThrow("already leased");
    const replacement = broker.acquire({
      ...binding.target, terminalId, terminalClientId: contender,
      requestId: newTerminalLeaseRequestId(),
      forceTerminalLeaseId: first.lease.terminalLeaseId,
    });
    expect(() => broker.renew({
      ...binding.target, terminalId, terminalClientId: owner, credential: first.credential,
    })).toThrow("stale or invalid");
    await new Promise((resolve) => setTimeout(resolve, 35));
    expect(() => broker.renew({
      ...binding.target, terminalId, terminalClientId: contender,
      credential: replacement.credential,
    })).toThrow("absent or expired");
    expect(broker.acquire({
      ...binding.target, terminalId, terminalClientId: owner,
      requestId: newTerminalLeaseRequestId(),
    }).lease.terminalClientId).toBe(owner);
    await broker.close();
  });

  it("replays cursors, resets stale viewers, and disconnects slow viewers", async () => {
    const { broker, provider, binding } = fixture({ subscriberItemLimit: 1 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    provider.opened[0]!.emit("one");
    provider.opened[0]!.emit("two");

    const replay = broker.attach({
      ...binding.target,
      terminalId,
      cursor: { terminalId, sequence: 1 },
    })[Symbol.asyncIterator]();
    expect(await replay.next()).toMatchObject({ value: { kind: "output", cursor: { sequence: 2 } } });

    const slow = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await slow.next()).value?.kind).toBe("reset");
    provider.opened[0]!.emit("fills buffer");
    provider.opened[0]!.emit("overflow");
    expect((await slow.next()).value?.kind).toBe("output");
    await expect(slow.next()).rejects.toBeInstanceOf(TerminalSubscriberOverflowError);

    await replay.return?.();
    await broker.close();
  });

  it("resets a stale cursor when one oversized replay item evicts itself", async () => {
    const { broker, provider, binding } = fixture({ replayByteLimit: 1 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    provider.opened[0]!.emit("output larger than the replay byte budget");

    const stale = broker.attach({
      ...binding.target,
      terminalId,
      cursor: { terminalId, sequence: 0 },
    })[Symbol.asyncIterator]();
    expect(await stale.next()).toMatchObject({
      done: false,
      value: {
        kind: "reset",
        reason: "cursorExpired",
        cursor: { terminalId, sequence: 1 },
      },
    });

    await stale.return?.();
    await broker.close();
  });

  it("includes control-only state in a reset without waiting for an xterm callback", async () => {
    const { broker, binding } = fixture();
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    broker.acquire({
      ...binding.target,
      terminalId,
      terminalClientId: newTerminalClientId(),
      requestId: newTerminalLeaseRequestId(),
    });

    const stream = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    await expect(stream.next()).resolves.toMatchObject({
      value: {
        kind: "reset",
        cursor: { sequence: 1 },
        terminal: { sequence: 1, lease: { terminalClientId: expect.any(String) } },
      },
      done: false,
    });
    await stream.return?.();
    await broker.close();
  });

  it("settles lease expiry before capturing one coherent reset sequence", async () => {
    const { broker, binding } = fixture({ leaseTtlMs: 10 });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    broker.acquire({
      ...binding.target,
      terminalId: opened.terminal.terminalId,
      terminalClientId: newTerminalClientId(),
      requestId: newTerminalLeaseRequestId(),
    });

    const originalNow = Date.now;
    Date.now = () => originalNow() + 1_000;
    try {
      const stream = broker.attach({
        ...binding.target,
        terminalId: opened.terminal.terminalId,
      })[Symbol.asyncIterator]();
      await expect(stream.next()).resolves.toMatchObject({
        done: false,
        value: {
          kind: "reset",
          cursor: { sequence: 2 },
          terminal: { sequence: 2, lease: null },
        },
      });
      await stream.return?.();
    } finally {
      Date.now = originalNow;
      await broker.close();
    }
  });

  it("fences replacement bindings, invalidates streams, and enforces process limits", async () => {
    const { broker, provider, binding, runtimeNodeId, adapterScopeId } = fixture({
      maxRunningTerminals: 1,
    });
    const opened = await broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (opened.status !== "opened") throw new Error("expected terminal to open");
    const terminalId = opened.terminal.terminalId;
    expect(() => broker.get({ ...binding.target, bindingRevision: 2 }))
      .toThrow("binding was replaced");

    const other = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    await expect(broker.open(other, {
      ...other.target,
      terminalClientId: newTerminalClientId(),
    })).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });

    const stream = broker.attach({ ...binding.target, terminalId })[Symbol.asyncIterator]();
    expect((await stream.next()).value?.kind).toBe("reset");
    broker.invalidateSession(binding.target.sessionId, "binding retired");
    expect(await stream.next()).toMatchObject({ value: { kind: "changed", terminal: {
      state: "exited", exit: { message: "binding retired" },
    } } });
    expect((await stream.next()).done).toBe(true);
    expect(broker.get(binding.target)).toBeNull();
    expect(provider.opened[0]!.kills).toBe(1);

    await expect(broker.open(other, {
      ...other.target,
      terminalClientId: newTerminalClientId(),
    })).resolves.toMatchObject({ status: "opened" });
    await broker.close();
  });

  it("reserves capacity across concurrent opens on different session locks", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:open-reservation");
    const provider = new GateProvider(adapterScopeId);
    const runtimeNodeId = newRuntimeNodeId();
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const secondBinding = bindingFor(newSessionId(), runtimeNodeId, adapterScopeId);
    const first = broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    await provider.entered;

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
    })).rejects.toMatchObject({ code: "RESOURCE_EXHAUSTED" });
    provider.release();
    await expect(first).resolves.toMatchObject({ status: "opened" });
    await broker.close();
  });

  it("does not install a native process that finishes opening after broker close", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("codex:open-close-race");
    const provider = new GateProvider(adapterScopeId);
    const binding = bindingFor(newSessionId(), newRuntimeNodeId(), adapterScopeId);
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
    });
    const opening = broker.open(binding, {
      ...binding.target,
      terminalClientId: newTerminalClientId(),
    });
    await provider.entered;
    await broker.close();
    provider.release();

    await expect(opening).rejects.toThrow("closed while the native terminal was opening");
    expect(provider.opened[0]?.kills).toBe(1);
    expect(broker.get(binding.target)).toBeNull();
  });

  it("fences and disposes an adapter-scoped foreground before reusing its process", async () => {
    const adapterScopeId = adapterScopeIdSchema.parse("copilot:shared-foreground");
    const provider = new SharedFakeProvider(adapterScopeId);
    const runtimeNodeId = newRuntimeNodeId();
    const broker = new TerminalBroker({
      runtimeNodeBootId: newRuntimeNodeBootId(),
      providers: [provider],
      maxRunningTerminals: 1,
    });
    const firstBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const secondBinding = bindingForHarness(
      "copilot",
      newSessionId(),
      runtimeNodeId,
      adapterScopeId,
    );
    const first = await broker.open(firstBinding, {
      ...firstBinding.target,
      terminalClientId: newTerminalClientId(),
    });
    if (first.status !== "opened") throw new Error("expected first foreground to open");
    const firstStream = broker.attach({
      ...firstBinding.target,
      terminalId: first.terminal.terminalId,
    })[Symbol.asyncIterator]();
    expect((await firstStream.next()).value?.kind).toBe("reset");

    await expect(broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
    })).resolves.toMatchObject({
      status: "confirmationRequired",
      reason: "foregroundSwitch",
      terminal: { sessionId: firstBinding.target.sessionId },
    });
    const second = await broker.open(secondBinding, {
      ...secondBinding.target,
      terminalClientId: newTerminalClientId(),
      confirmForegroundSwitch: true,
      expectedTerminalId: first.terminal.terminalId,
    });
    if (second.status !== "opened") throw new Error("expected second foreground to open");
    expect(second.terminal.terminalId).not.toBe(first.terminal.terminalId);
    expect(provider.opens).toHaveLength(2);
    expect(provider.opens[1]).toMatchObject({ foregroundSwitch: true });
    expect(await firstStream.next()).toMatchObject({
      value: {
        kind: "changed",
        terminal: {
          state: "exited",
          exit: { message: "terminal foreground moved to another session" },
        },
      },
    });
    expect((await firstStream.next()).done).toBe(true);
    expect(broker.get(firstBinding.target)).toBeNull();
    expect(broker.get(secondBinding.target)?.foregroundSessionId)
      .toBe(secondBinding.target.sessionId);
    const secondStream = broker.attach({
      ...secondBinding.target,
      terminalId: second.terminal.terminalId,
    })[Symbol.asyncIterator]();
    expect((await secondStream.next()).value?.kind).toBe("reset");
    provider.process.emit("shared process remains attached");
    expect(await secondStream.next()).toMatchObject({
      value: { kind: "output" },
      done: false,
    });
    await secondStream.return?.();

    await broker.close();
    expect(provider.process.kills).toBe(0);
    expect(provider.closes).toBe(1);
  });
});

describe("RuntimeNodeService terminal lifecycle", () => {
  it.each(["codex", "copilot"] as const)(
    "retires a managed %s terminal when the structured session stops",
    async (harness) => {
      const runtimeNodeId = newRuntimeNodeId();
      const runtimeNodeBootId = newRuntimeNodeBootId();
      const sessionId = newSessionId();
      const adapterScopeId = adapterScopeIdSchema.parse(`${harness}:terminal-test`);
      const adapter = stoppingAdapter(harness, adapterScopeId);
      const provider = new HarnessFakeProvider(
        harness,
        adapterScopeId,
        harness === "codex",
      );
      const store = new RuntimeNodeStore(":memory:");
      const service = new RuntimeNodeService({
        store,
        runtimeNodeId,
        runtimeNodeBootId,
        name: `${harness} terminal test`,
        allowedRoots: ["/tmp"],
        adapters: [adapter],
        terminalProviders: [provider],
      });
      const profile = service.listLaunchProfiles()[0]!;
      const launchId = newLaunchId();
      service.createLaunch({
        launchId,
        payloadHash: `${harness}-terminal-spawn`,
        sessionId,
        runtimeNodeId,
        profile: {
          profileId: profile.profileId,
          providerId: profile.providerId,
          contractVersion: profile.contractVersion,
          requestSchemaHash: profile.requestSchemaHash,
        },
        harness,
        input: { cwd: "/tmp" },
      });
      while (service.getLaunch(launchId)?.state !== "succeeded") {
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      const target = { sessionId, runtimeNodeId, bindingRevision: 1 };
      const opened = await service.terminalOpen({
        ...target,
        terminalClientId: newTerminalClientId(),
      });
      if (opened.status !== "opened") throw new Error("expected terminal to open");
      const stream = service.terminalAttach({
        ...target,
        terminalId: opened.terminal.terminalId,
      })[Symbol.asyncIterator]();
      expect((await stream.next()).value?.kind).toBe("reset");

      await expect(service.stop({
        operation: "stop",
        commandId: newCommandId(),
        payloadHash: `${harness}-terminal-stop`,
        sessionId,
        runtimeNodeId,
        bindingRevision: 1,
      })).resolves.toMatchObject({ state: "succeeded" });
      await expect(stream.next()).resolves.toMatchObject({
        value: {
          kind: "changed",
          terminal: {
            state: "exited",
            exit: { message: `structured ${harness} session was stopped` },
          },
        },
      });
      expect((await stream.next()).done).toBe(true);
      expect(service.terminalGet(target)).toBeNull();
      expect(provider.opened[0]?.kills).toBe(harness === "codex" ? 1 : 0);

      await service.close();
      store.close();
    },
  );
});

describe("terminalProcessFromPty", () => {
  it("buffers startup output and an early exit until the broker listeners attach", async () => {
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    pty.emitData("startup");
    pty.emitExit({ exitCode: 7, signal: 0 });
    const output: string[] = [];
    const exits: TerminalProcessExit[] = [];
    process.onData((data) => output.push(data));
    process.onExit((exit) => exits.push(exit));
    expect(output).toEqual(["startup"]);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(exits).toEqual([{ exitCode: 7, signal: 0 }]);
  });

  it("keeps the PTY source attached across sequential foreground listeners", () => {
    const pty = new FakePty();
    const process = terminalProcessFromPty(pty as unknown as IPty);
    const first: string[] = [];
    const dispose = process.onData((data) => first.push(data));
    pty.emitData("first");
    dispose();
    pty.emitData("between");
    const second: string[] = [];
    process.onData((data) => second.push(data));
    pty.emitData("second");
    expect(first).toEqual(["first"]);
    expect(second).toEqual(["between", "second"]);
  });
});

describe("sanitizedTerminalEnvironment", () => {
  it("keeps native harness configuration but removes the entire Multiplex namespace", () => {
    expect(sanitizedTerminalEnvironment({
      PATH: "/bin",
      CODEX_HOME: "/native-auth",
      AGENT_MULTIPLEX_SHARED_SECRET: "secret",
      AGENT_MULTIPLEX_CONTROL_NODE_ENDPOINT_ID: "transport-identity",
      AGENT_MULTIPLEX_RUNTIME_NODE_COPILOT_PROVIDER_API_KEY_FILE: "/run/secrets/key",
    })).toEqual({ PATH: "/bin", CODEX_HOME: "/native-auth" });
  });
});

class FakePty {
  readonly pid = 123;
  readonly process = "fake";
  readonly cols = 80;
  readonly rows = 24;
  readonly #data = new Set<(data: string) => void>();
  readonly #exit = new Set<(event: { exitCode: number; signal?: number }) => void>();
  onData(listener: (data: string) => void): IDisposable {
    this.#data.add(listener);
    return { dispose: () => this.#data.delete(listener) };
  }
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable {
    this.#exit.add(listener);
    return { dispose: () => this.#exit.delete(listener) };
  }
  write(): void {}
  resize(): void {}
  clear(): void {}
  pause(): void {}
  resume(): void {}
  kill(): void {}
  emitData(data: string): void { for (const listener of this.#data) listener(data); }
  emitExit(event: { exitCode: number; signal?: number }): void {
    for (const listener of this.#exit) listener(event);
  }
}

class HarnessFakeProvider implements TerminalProvider {
  public readonly backend = "mock" as const;
  public readonly sharing = "session" as const;
  public readonly capabilities;
  public readonly opened: FakeProcess[] = [];

  public constructor(
    public readonly harness: Harness,
    public readonly adapterScopeId: AdapterScopeId,
    terminate: boolean,
  ) {
    this.capabilities = {
      write: true,
      resize: true,
      terminate,
      restart: terminate,
      foregroundSwitch: false,
    };
  }

  public async open(): Promise<TerminalProcess> {
    const process = new FakeProcess();
    this.opened.push(process);
    return process;
  }

  public async close(): Promise<void> {}
}

class SharedFakeProvider implements TerminalProvider {
  public readonly harness = "copilot" as const;
  public readonly backend = "mock" as const;
  public readonly sharing = "adapterScope" as const;
  public readonly capabilities = {
    write: true,
    resize: true,
    terminate: false,
    restart: false,
    foregroundSwitch: true,
  } as const;
  public readonly process = new FakeProcess();
  public readonly opens: TerminalProviderOpenRequest[] = [];
  public closes = 0;

  public constructor(public readonly adapterScopeId: AdapterScopeId) {}

  public async open(request: TerminalProviderOpenRequest): Promise<TerminalProcess> {
    this.opens.push(request);
    return this.process;
  }

  public async close(): Promise<void> { this.closes += 1; }
}

class GateProvider extends FakeProvider {
  readonly entered: Promise<void>;
  readonly #markEntered: () => void;
  readonly #gate: Promise<void>;
  readonly #release: () => void;

  public constructor(adapterScopeId: AdapterScopeId) {
    super(adapterScopeId);
    let markEntered = (): void => undefined;
    let release = (): void => undefined;
    this.entered = new Promise((resolve) => { markEntered = resolve; });
    this.#gate = new Promise((resolve) => { release = resolve; });
    this.#markEntered = markEntered;
    this.#release = release;
  }

  public override async open(): Promise<TerminalProcess> {
    this.#markEntered();
    await this.#gate;
    return super.open();
  }

  public release(): void { this.#release(); }
}

function stoppingAdapter(harness: Harness, adapterScopeId: AdapterScopeId): AgentAdapter {
  const session: AdapterSession = {
    harness,
    adapterScopeId,
    vendorSessionId: `${harness}-native-session`,
    cwd: "/tmp",
    runtimeEpoch: newRuntimeEpoch(),
    status: () => "idle",
    subscribe: () => () => undefined,
    execute: async () => ({}),
    readNativeHistory: async (request) => ({
      harness: request.harness,
      vendorSessionId: `${harness}-native-session`,
      payload: [],
      nextCursor: null,
      complete: true,
    }),
    stop: async () => undefined,
  };
  return {
    harness,
    adapterScopeId,
    describe: async () => ({
      harness,
      adapterScopeId,
      available: true,
      capabilities: [],
    }),
    listModels: async () => [],
    listSessions: async () => [],
    spawn: async () => session,
    resume: async () => session,
    close: async () => undefined,
  };
}
