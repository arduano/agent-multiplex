import { codexProtocol } from "../../v8-harness-codex/src/protocol.js";
import { copilotProtocol } from "../../v8-harness-copilot/src/protocol.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Catalog, ControlCommand, Harness, Interaction, NativeEvent, NativeOutcome, NativePort, NativeRun, NativeStart, RunRef, SessionCommand, SessionScope, StopProof } from "../src/contracts/types.js";
import { SessionHost, type SessionHostOptions } from "../../v8-lifecycle-default/src/session/index.js";

export const scope: SessionScope = { connection: "connection", principal: "principal", host: "host", session: "session" };
export const defer = <T>() => { let resolve!: (value: T) => void; let reject!: (reason: unknown) => void; const promise = new Promise<T>((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20000): Promise<void> { const end = Date.now() + timeoutMs; while (!await check()) { if (Date.now() > end) throw new Error("bounded condition timed out"); await new Promise(resolve => setTimeout(resolve, 2)); } }
export class ScriptedPort implements NativePort {
  get protocol() { return this.kind === "codex" ? codexProtocol : copilotProtocol; }
  readonly placement = "shared" as const;
  readonly capabilities = { fullStop: true, createAndWait: true, reopen: true, commands: ["send", "answer", "codex.continue", "codex.defaults", "codex.turn", "codex.interrupt", "copilot.mode", "copilot.model", "copilot.permissions", "copilot.abort"] as const };
  readonly starts: NativeStart[] = []; readonly calls: ControlCommand[] = []; readonly inspections: RunRef[] = [];
  stops = 0; emit: (event: NativeEvent) => void = () => {}; run: RunRef | undefined;
  startGate: Promise<void> | undefined; invokeGate: Promise<NativeOutcome> | undefined; stopGate: Promise<StopProof> | undefined; catalogGate: Promise<Catalog> | undefined;
  complete = true; interactions: readonly Interaction[] = []; inspectResult: NativeRun | StopProof | null | undefined;
  outcomes: NativeOutcome[] = []; onStart: (() => void) | undefined;
  constructor(readonly kind: Harness = "codex") {}
  handle(run = this.run!): NativeRun { return { run, selection: this.kind === "codex" ? { kind: "codex", model: "model-a", effort: "low" } : { kind: "copilot", model: "model-a", providerId: "provider", effort: "low" }, interactionsComplete: this.complete, interactions: this.interactions, stop: async () => { this.stops++; return this.stopGate ?? this.proof(run); }, invoke: async command => { this.calls.push(command); return this.invokeGate ?? this.outcomes.shift() ?? { status: "applied" }; } }; }
  proof(run = this.run!): StopProof { return { run, state: "stopped", scope: "nativeTree", noAutomaticContinuation: true }; }
  async start(input: NativeStart, emit: (event: NativeEvent) => void): Promise<NativeRun> { this.starts.push(input); this.emit = emit; this.run = { scope: input.scope, generation: input.generation, nativeSession: input.nativeSession ?? "native-original" }; this.onStart?.(); await this.startGate; return this.handle(); }
  async inspect(run: RunRef, emit: (event: NativeEvent) => void): Promise<NativeRun | StopProof | null> { this.inspections.push(run); this.emit = emit; this.run = run; return this.inspectResult === undefined ? this.handle(run) : this.inspectResult; }
  async catalog(): Promise<Catalog> { return this.catalogGate ?? { available: true, choices: [{ model: "model-a", providerId: this.kind === "copilot" ? "provider" : undefined, efforts: ["low", "high"] }, { model: "model-b", efforts: ["low"] }].map(value => Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))) as unknown as Catalog["choices"] }; }
}
export async function fixture(port = new ScriptedPort(), options: Partial<SessionHostOptions> = {}) {
  const directory = await mkdtemp(join(process.env.V8_SESSION_TMPDIR ?? tmpdir(), "v8-session-host-"));
  let host = await SessionHost.open({ directory, scope, port, policy: port.kind === "codex" ? { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } : { kind: "copilot", permissions: "manual", provider: "copilot-only" }, observationMs: 10000, ...options });
  let serial = 0;
  return { directory, port, get host() { return host; }, async submit(command: SessionCommand, generation?: number) { return host.submit({ scope, id: `operation-${++serial}`, generation: generation ?? (await host.snapshot(scope)).generation, command }); }, async create() { return this.submit({ type: "create" }); }, async reopen() { await host.terminate(); host = await SessionHost.open({ directory, scope, port, policy: port.kind === "codex" ? { kind: "codex", access: { approval: "on-request", sandbox: "danger-full-access" }, provider: "copilot-only" } : { kind: "copilot", permissions: "manual", provider: "copilot-only" }, observationMs: 10000, ...options }); return host; }, async dispose() { await host.terminate(); await rm(directory, { recursive: true, force: true }); } };
}
