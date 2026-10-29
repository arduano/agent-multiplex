import {
  openingProof,
  type NativeAllocation,
  type OpeningCapsule,
  type OpeningRef,
  type ReaderCustodyPort,
} from "../../runtime/index.js";
import type { HistoryReadPort } from "../../history/index.js";
import { scopeKey, type RunRef } from "../../protocol/index.js";
import { COPILOT_CLI_VERSION } from "../contracts.js";
import type { ClientFactory, ClientInput, SdkClient } from "../sdk-contracts.js";
import { historyPort } from "./history.js";
import { check, CopilotError } from "./validation.js";
import type { Event } from "../sdk-contracts.js";
export type CopilotReaderOptions = Readonly<{
  run: RunRef;
  opening: OpeningRef;
  stream: string;
  custody: ReaderCustodyPort;
  allocate(): NativeAllocation;
  client: ClientFactory;
  input(launcher: string): ClientInput;
  lifetimeMs?: number;
  project?: (event: Event) => Promise<Event>;
}>;
/** Only the SDK's sessionless persisted event RPC is exposed. No Resume exists. */
export class CopilotReader {
  readonly logicalScope: string;
  private owner: NativeAllocation | undefined;
  private capsule: OpeningCapsule | undefined;
  private client: SdkClient | undefined;
  private closing: Promise<void> | undefined;
  private closed = false;
  private retired = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private calls = 0;
  constructor(
    private readonly options: CopilotReaderOptions,
    private readonly released: () => void,
  ) {
    this.logicalScope = scopeKey(options.run.scope);
  }
  async open(): Promise<void> {
    const lifetime = this.options.lifetimeMs ?? 240000;
    check(Number.isSafeInteger(lifetime) && lifetime > 0 && lifetime <= 300000, "READER_LIFETIME");
    await this.options.custody.begin(this.options.run, this.options.opening);
    this.owner = this.options.allocate();
    try {
      const held = await this.owner.opening(this.options.opening);
      this.capsule = { opening: held.opening, identity: held.identity };
      await this.options.custody.owned(this.options.run, this.capsule);
      this.timer = setTimeout(() => {
        void this.close().catch(() => {});
      }, lifetime);
      this.timer.unref();
      const prepared = await this.owner.prepare();
      this.owner.assertLaunchable();
      this.client = await this.options.client(this.options.input(prepared.launcher));
      await this.client.start();
      check((await this.client.getStatus()).version === COPILOT_CLI_VERSION, "CLI_PIN");
      this.assertCurrent();
    } catch (error) {
      if (!this.capsule && this.owner.identity) {
        this.capsule = { opening: this.options.opening, identity: this.owner.identity };
        await this.options.custody.owned(this.options.run, this.capsule).catch(() => {});
      }
      try {
        await this.close();
      } catch (cleanup) {
        throw new AggregateError(
          [error, cleanup],
          "Copilot reader acquisition and cleanup remain owned",
          { cause: cleanup },
        );
      }
      throw error;
    }
  }
  private assertCurrent(): void {
    check(
      !this.closed && this.owner && !this.owner.sealed && this.client && this.capsule,
      "READER_RETIRED",
    );
  }
  get usable(): boolean {
    return !this.closed && !this.retired && !!this.client && this.calls < 256;
  }
  port(): HistoryReadPort {
    this.assertCurrent();
    return historyPort(
      {
        run: this.options.run,
        attachment: this.capsule!.identity.attachment,
        stream: this.options.stream,
      },
      "persisted",
      async (request) => {
        this.assertCurrent();
        check(++this.calls <= 256, "READER_CALL_BOUND");
        const result = await this.client!.rpc.sessions.readPersistedEvents(request);
        this.assertCurrent();
        return result;
      },
      this.options.project,
    );
  }
  close(): Promise<void> {
    if (this.retired) return Promise.resolve();
    if (this.closing) return this.closing;
    this.closed = true;
    clearTimeout(this.timer);
    const closing = (async () => {
      const results = await Promise.allSettled([this.owner?.stop(), this.client?.forceStop()]);
      const stopped = results[0];
      check(
        stopped?.status === "fulfilled" && stopped.value && this.capsule,
        "READER_STOP_UNPROVED",
      );
      const proof = openingProof(this.capsule, {
        ...this.capsule,
        identity: stopped.value,
        state: "stopped",
        scope: "nativeTree",
        noAutomaticContinuation: true,
        acquisitionSealed: true,
      });
      if (results.some((result) => result.status === "rejected"))
        throw new CopilotError("READER_CLEANUP_UNPROVED");
      await this.options.custody.released(proof);
      this.retired = true;
      this.released();
    })();
    this.closing = closing;
    return closing.finally(() => {
      this.closing = undefined;
    });
  }
}
