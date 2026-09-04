import {
  adapterScopeIdSchema,
  newRuntimeNodeBootId,
  newRuntimeNodeId,
  newSessionId,
  newTerminalClientId,
  newTerminalLeaseRequestId,
  type AdapterScopeId,
} from "@arduano/agent-multiplex-protocol";
import {
  TerminalBroker,
  type TerminalBinding,
  type TerminalProcess,
  type TerminalProcessExit,
  type TerminalProvider,
} from "@arduano/agent-multiplex-runtime-node-core";
import { describe, expect, it } from "vitest";

class ScaleProcess implements TerminalProcess {
  // Scale processes do not emit until after broker attachment.
  readonly startupOutputComplete = true;
  readonly dataListeners = new Set<(data: string) => void>();
  readonly exitListeners = new Set<(exit: TerminalProcessExit) => void>();
  readonly writes: string[] = [];

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (exit: TerminalProcessExit) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  write(data: string): void { this.writes.push(data); }
  resize(): void {}
  kill(): void {}

  emit(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }
}

class ScaleProvider implements TerminalProvider {
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
  readonly processes: ScaleProcess[] = [];

  constructor(readonly adapterScopeId: AdapterScopeId) {}

  async open(): Promise<TerminalProcess> {
    const process = new ScaleProcess();
    this.processes.push(process);
    return process;
  }

  async close(): Promise<void> {}
}

describe("managed terminal scale", () => {
  it("streams 100 terminals through ten independent worker brokers", async () => {
    const workers = Array.from({ length: 10 }, (_, workerIndex) => {
      const adapterScopeId = adapterScopeIdSchema.parse(`codex:scale-${workerIndex}`);
      const provider = new ScaleProvider(adapterScopeId);
      return {
        adapterScopeId,
        provider,
        runtimeNodeId: newRuntimeNodeId(),
        broker: new TerminalBroker({
          runtimeNodeBootId: newRuntimeNodeBootId(),
          providers: [provider],
          maxRunningTerminals: 10,
        }),
      };
    });

    const terminals = await Promise.all(workers.flatMap((worker, workerIndex) =>
      Array.from({ length: 10 }, async (_, terminalIndex) => {
        const sessionId = newSessionId();
        const binding: TerminalBinding = {
          target: {
            sessionId,
            runtimeNodeId: worker.runtimeNodeId,
            bindingRevision: 1,
          },
          harness: "codex",
          adapterScopeId: worker.adapterScopeId,
          vendorSessionId: `native-${workerIndex}-${terminalIndex}`,
          cwd: "/tmp",
        };
        const opened = await worker.broker.open(binding, {
          ...binding.target,
          terminalClientId: newTerminalClientId(),
        });
        if (opened.status !== "opened") throw new Error("scale terminal did not open");
        return { worker, binding, descriptor: opened.terminal, workerIndex, terminalIndex };
      }),
    ));

    expect(terminals).toHaveLength(100);
    const viewers = terminals.flatMap((terminal) => [0, 1].map(() =>
      terminal.worker.broker.attach({
        ...terminal.binding.target,
        terminalId: terminal.descriptor.terminalId,
      })[Symbol.asyncIterator](),
    ));
    const resets = await Promise.all(viewers.map((viewer) => viewer.next()));
    expect(resets.every((item) =>
      item.done === false && item.value.kind === "replayStart"
    )).toBe(true);
    const replayEnds = await Promise.all(viewers.map((viewer) => viewer.next()));
    expect(replayEnds.every((item) =>
      item.done === false && item.value.kind === "replayEnd"
    )).toBe(true);

    terminals.forEach((terminal) => {
      terminal.worker.provider.processes[terminal.terminalIndex]!
        .emit(`worker-${terminal.workerIndex}/terminal-${terminal.terminalIndex}`);
    });
    const outputs = await Promise.all(viewers.map((viewer) => viewer.next()));
    expect(outputs.every((item) => item.done === false && item.value.kind === "output")).toBe(true);
    outputs.forEach((item, viewerIndex) => {
      if (item.done || item.value.kind !== "output") throw new Error("expected terminal output");
      const terminal = terminals[Math.floor(viewerIndex / 2)]!;
      expect(Buffer.from(item.value.dataBase64, "base64").toString("utf8"))
        .toBe(`worker-${terminal.workerIndex}/terminal-${terminal.terminalIndex}`);
    });

    for (const terminal of terminals) {
      const terminalClientId = newTerminalClientId();
      const acquired = terminal.worker.broker.acquire({
        ...terminal.binding.target,
        terminalId: terminal.descriptor.terminalId,
        terminalClientId,
        requestId: newTerminalLeaseRequestId(),
      });
      terminal.worker.broker.input({
        ...terminal.binding.target,
        terminalId: terminal.descriptor.terminalId,
        terminalClientId,
        credential: acquired.credential,
        inputSequence: 0,
        kind: "write",
        dataBase64: Buffer.from("x", "utf8").toString("base64"),
      });
    }
    expect(workers.flatMap(({ provider }) => provider.processes)
      .every((process) => process.writes.join("") === "x")).toBe(true);

    await Promise.all(viewers.map((viewer) => viewer.return?.()));
    await Promise.all(workers.map(({ broker }) => broker.close()));
  });
});
