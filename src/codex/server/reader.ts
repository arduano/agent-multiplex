import type { CodexReaderLease, CodexReaderOptions } from "../node-contracts.js";
import type { NativeAllocation, OpeningCapsule, OpeningStopProof } from "../../runtime/index.js";
import { canonical, openingCapsule, openingProof } from "../../runtime/index.js";
import type { HistoryReadPort, HistoryScope } from "../../history/index.js";
import { scopeKey, type RunRef } from "../../protocol/index.js";
import { prepareCodexHome } from "./config.js";
import { CodexMedia } from "./media.js";
import { codexTimelinePage } from "./history.js";
import { proveLineage, threadMetadata } from "./lineage.js";
import { CodexRpc, spawnCodexWire } from "./rpc.js";
import { check, equal, object } from "./validation.js";

/** Explicit sessionless native reader. Its only RPC surface is observational;
 * thread/start, thread/resume and all mutations are absent. Direct construction
 * requires the consumer to exclusively own this lease until actual close;
 * normal consumers use CodexAdapter.reader's same-scope admission. */
export class CodexReader {
  readonly logicalScope: string;
  #owner: NativeAllocation | undefined;
  #capsule: OpeningCapsule | undefined;
  #rpc: CodexRpc | undefined;
  #closed = false;
  #closing: Promise<void> | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #calls = 0;
  #initialized = false;
  #cleanupFailed = false;
  readonly #media = new Set<CodexMedia>();
  constructor(
    readonly options: CodexReaderOptions,
    readonly lease: CodexReaderLease,
    readonly retired: () => void = () => {},
  ) {
    this.logicalScope = scopeKey(lease.opening.scope);
  }
  async open(): Promise<this> {
    const { options, lease } = this;
    try {
      await prepareCodexHome(options.home, options);
    } catch (error) {
      if (!lease.prior) {
        this.#closed = true;
        this.retired();
      }
      throw error;
    }
    if (lease.prior) {
      check(equal(lease.prior.opening.scope, lease.opening.scope), "READER_SCOPE");
      const old = await options.allocation.inspectOpening(lease.prior, "reader");
      check(old, "READER_CUSTODY_UNKNOWN");
      const proof = "state" in old ? old : await old.stop();
      openingProof(lease.prior, proof);
      await lease.released(proof);
    }
    await lease.begin(lease.opening);
    const owner = options.allocation.allocate({
      directory: options.directory,
      binary: options.binary,
      packageRoot: options.packageRoot,
      home: options.home,
      cwd: options.cwd,
      args: ["app-server", "--stdio"],
      environment: { ...options.environment, CODEX_HOME: options.home },
      reference: canonical(lease.opening),
      kind: "reader",
    });
    this.#owner = owner;
    try {
      const duration = options.lifetimeMs ?? 240000;
      check(
        Number.isSafeInteger(duration) && duration >= 1 && duration <= 300000,
        "READER_LIFETIME",
      );
      this.#timer = setTimeout(() => {
        void this.close().catch(() => {});
      }, duration);
      this.#timer.unref();
      const opening = await owner.opening(lease.opening);
      this.#capsule = { opening: opening.opening, identity: opening.identity };
      await lease.owned(this.#capsule);
      const prepared = await owner.prepare();
      owner.assertLaunchable();
      const rpc = new CodexRpc(
        (options.wire ?? spawnCodexWire)({
          node: options.node,
          launcher: prepared.launcher,
          cwd: options.cwd,
          environment: { ...options.environment, CODEX_HOME: options.home },
        }),
        (value) => {
          if (["turn/started", "item/started"].includes(value.method))
            void this.close().catch(() => {});
        },
        () => {
          void this.close().catch(() => {});
        },
        () => {},
      );
      this.#rpc = rpc;
      await rpc.initialize();
      this.assertCurrent();
      this.#initialized = true;
      return this;
    } catch (error) {
      if (!this.#capsule && owner.identity) {
        this.#capsule = openingCapsule({ opening: lease.opening, identity: owner.identity });
        await lease.owned(this.#capsule).catch(() => {});
      }
      await this.close().catch(() => {});
      throw error;
    }
  }
  assertCurrent(): void {
    check(
      !this.#closed &&
        this.#owner &&
        !this.#owner.sealed &&
        this.#rpc?.observation.connected &&
        this.#rpc.observation.turnStarts === 0 &&
        this.#rpc.observation.itemStarts === 0 &&
        this.#rpc.observation.reverse === 0,
      "READER_RETIRED",
    );
  }
  get usable(): boolean {
    try {
      this.assertCurrent();
      return this.#calls < 64;
    } catch {
      return false;
    }
  }
  request(
    method: "model/list" | "thread/read" | "thread/timeline/list" | "thread/items/list",
    params: unknown,
  ): Promise<unknown> {
    this.assertCurrent();
    check(++this.#calls <= 64, "READER_CALL_BOUND");
    return this.#rpc!.request(method, params).then((value) => {
      this.assertCurrent();
      return value;
    });
  }
  async authorize(run: RunRef, thread: string, current: () => void): Promise<void> {
    current();
    check(
      equal(run.scope, this.lease.opening.scope) &&
        run.generation === this.lease.opening.generation,
      "READER_RUN_FENCED",
    );
    const metadata: unknown[] = [],
      seen = new Set<string>();
    let selected = thread;
    for (let depth = 0; depth <= 32; depth++) {
      current();
      const raw = object(
        await this.request("thread/read", { threadId: selected, includeTurns: false }),
      ).thread;
      current();
      const node = threadMetadata(raw);
      check(node.id === selected && !seen.has(node.id), "READER_ANCESTRY");
      metadata.push(raw);
      seen.add(node.id);
      if (selected === run.nativeSession) {
        if (thread !== run.nativeSession) proveLineage(run.nativeSession, thread, metadata);
        return;
      }
      check(node.parent, "READER_ANCESTRY");
      selected = node.parent;
    }
    throw new Error("Codex ancestry bound");
  }
  history(scope: HistoryScope): HistoryReadPort {
    let media: CodexMedia | undefined;
    return {
      scope,
      mode: "repeatable",
      read: async (input, assertCurrent) => {
        check(
          Number.isSafeInteger(input.count) &&
            input.count >= 1 &&
            input.count <= 128 &&
            (input.cursor === null ||
              (typeof input.cursor === "string" && input.cursor.length <= 8192)),
          "HISTORY_READ_INPUT",
        );
        await this.authorize(scope.run, scope.stream, assertCurrent);
        assertCurrent();
        const raw = await this.request("thread/timeline/list", {
          threadId: scope.stream,
          cursor: input.cursor,
          limit: input.count,
        });
        assertCurrent();
        const result = codexTimelinePage(scope, raw);
        if (result.status === "page")
          check(
            result.nextCursor === null || result.nextCursor !== input.cursor,
            "HISTORY_CURSOR_STALLED",
          );
        media ??= new CodexMedia(
          scope.run,
          scope.attachment,
          this.options.media,
          () => undefined,
          () => !this.#closed,
        );
        this.#media.add(media);
        try {
          await media.preparePage(
            raw,
            () => {
              this.assertCurrent();
              assertCurrent();
            },
            scope.stream,
          );
          this.assertCurrent();
          assertCurrent();
          return codexTimelinePage(scope, raw, media);
        } finally {
          this.#media.delete(media);
        }
      },
    };
  }
  /** Ready to retire, not already empty: an idle read-only tree can be closed
   * without cancelling business work. Initialization, actual reads and unknown
   * cleanup remain retained until their own result. */
  readyToClose(): boolean {
    return (
      this.#initialized &&
      !this.#cleanupFailed &&
      this.#media.size === 0 &&
      this.#rpc?.observation.pending === 0
    );
  }
  close(): Promise<void> {
    return (this.#closing ??= (async () => {
      this.#closed = true;
      clearTimeout(this.#timer);
      for (const media of this.#media) media.seal();
      const results = await Promise.allSettled([
        this.#owner?.stop(),
        this.#rpc?.close(),
        ...[...this.#media].map((media) => media.settled()),
      ]);
      const identity = results[0];
      check(
        identity?.status === "fulfilled" && identity.value && this.#capsule,
        "READER_RETIREMENT_UNKNOWN",
      );
      const proof: OpeningStopProof = {
        ...this.#capsule,
        identity: identity.value,
        state: "stopped",
        scope: "nativeTree",
        acquisitionSealed: true,
        noAutomaticContinuation: true,
      };
      openingProof(this.#capsule, proof);
      check(
        results.every((value) => value.status === "fulfilled"),
        "READER_ATTACHMENT_UNKNOWN",
      );
      await this.lease.released(proof);
      this.retired();
    })().catch((error) => {
      this.#cleanupFailed = true;
      throw error;
    }));
  }
}
