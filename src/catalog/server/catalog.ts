import { z } from "zod";
import {
  canonicalJson,
  cloneJson,
  scopeKey,
  type Json,
  type Receipt,
  type SessionScope,
} from "../../protocol/index.js";
import type { CatalogOptions } from "../node-contracts.js";
import type { CatalogEntry, CatalogPatch, CreateRequest, CreationEvidence } from "../index.js";

const id = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[^\x00-\x1f\x7f]+$/);
const scopeSchema = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const json = z.custom<Json>((value) => {
  try {
    canonicalJson(value as Json, 65536);
    return true;
  } catch {
    return false;
  }
});
const target = z
  .object({
    owner: id,
    nativeKind: id,
    contractId: id,
    contractVersion: z.number().int().positive(),
  })
  .strict();
const requestSchema = z
  .object({
    scope: scopeSchema,
    id,
    target,
    name: z.string().max(512),
    workspace: json,
    selection: json,
    data: json.default(null),
  })
  .strict();
const archiveSchema = z
  .object({
    type: z.literal("catalog.archive"),
    hostOriginalId: id,
    generation: z.number().int().positive(),
  })
  .strict();
const recordSchema = z
  .object({
    version: z.literal(1),
    original: requestSchema,
    entry: z
      .object({
        scope: scopeSchema,
        authority: id,
        revision: z.number().int().positive(),
        target,
        name: z.string().max(512),
        workspace: json,
        data: json,
        watched: z.boolean(),
        creation: z.enum(["reserved", "unknown", "created", "refused"]),
        createId: id,
        binding: z
          .object({
            scope: scopeSchema,
            generation: z.number().int().positive(),
            nativeSession: id,
          })
          .strict()
          .nullable(),
        archived: z.boolean(),
      })
      .strict(),
  })
  .strict();
type Record = z.output<typeof recordSchema>;
const copy = <T>(value: T): T => cloneJson(value as Json, 262144) as T;
const owners = new WeakSet<object>();

/** One Root journal and one creation-workflow owner. The Host owns the native
 * effect separately; a lost Root→Host reply is reconciled by read, never replay. */
export class Catalog {
  readonly #records = new Map<string, Record>();
  readonly #actual = new Set<Promise<unknown>>();
  readonly #archiveReads = new Map<string, Promise<Receipt>>();
  readonly #listeners = new Set<() => void>();
  #closed = false;
  constructor(private readonly options: CatalogOptions) {
    id.parse(options.authority);
    if (!Number.isSafeInteger(options.maxEntries ?? 2048) || (options.maxEntries ?? 2048) < 1)
      throw new TypeError("Invalid catalog capacity");
    if (owners.has(options.journal.writerIdentity)) throw new Error("Catalog writer already owned");
    for (const checkpoint of options.journal.checkpoints()) {
      const record = recordSchema.parse(checkpoint.value);
      if (
        record.entry.authority !== options.authority ||
        scopeKey(record.entry.scope) !== scopeKey(checkpoint.scope) ||
        scopeKey(record.original.scope) !== scopeKey(checkpoint.scope)
      )
        throw new Error("Catalog scope fenced");
      this.#records.set(scopeKey(checkpoint.scope), record);
    }
    owners.add(options.journal.writerIdentity);
  }
  get authority(): string {
    return this.options.authority;
  }
  #active() {
    if (this.#closed) throw new Error("Catalog closed");
  }
  #get(scope: SessionScope): Record {
    this.#active();
    const record = this.#records.get(scopeKey(scope));
    if (!record) throw new Error("Unknown catalog session");
    return record;
  }
  #publish() {
    for (const listener of this.#listeners)
      try {
        listener();
      } catch {
        /* Observation owns no work. */
      }
  }
  #settle(
    record: Record,
    operationId: string,
    result: { state: "unknown" } | { state: "succeeded" | "refused"; result: Json },
  ) {
    const receipt = this.options.journal.settle(record.entry.scope, operationId, result, {
      scope: record.entry.scope,
      value: copy(record) as unknown as Json,
    });
    return receipt;
  }
  #own<T>(work: Promise<T>): Promise<T> {
    this.#actual.add(work);
    void work.finally(() => this.#actual.delete(work)).catch(() => {});
    return work;
  }
  get(scope: SessionScope): CatalogEntry | null {
    this.#active();
    const record = this.#records.get(scopeKey(scope));
    return record ? copy(record.entry) : null;
  }
  list(identity: Pick<SessionScope, "connection" | "principal">): readonly CatalogEntry[] {
    this.#active();
    return [...this.#records.values()]
      .filter(
        (record) =>
          record.entry.scope.connection === identity.connection &&
          record.entry.scope.principal === identity.principal,
      )
      .map((record) => copy(record.entry));
  }
  original(scope: SessionScope, operationId: string): Receipt | null {
    this.#active();
    return this.options.journal.read(scope, operationId);
  }
  subscribe(listener: () => void) {
    this.#active();
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  create(input: CreateRequest): Promise<Receipt> {
    this.#active();
    const request = requestSchema.parse(cloneJson(input as unknown as Json, 262144));
    const record: Record = {
      version: 1,
      original: request,
      entry: {
        scope: request.scope,
        authority: this.options.authority,
        revision: 1,
        target: request.target,
        name: request.name,
        workspace: request.workspace,
        data: request.data ?? null,
        watched: false,
        creation: "reserved",
        createId: request.id,
        binding: null,
        archived: false,
      },
    };
    const canReserve =
      !this.#records.has(scopeKey(request.scope)) &&
      this.#records.size < (this.options.maxEntries ?? 2048);
    // One transaction admits the original and reserves its scope, or neither.
    // Duplicate admission never reapplies this older candidate checkpoint.
    const admitted = this.options.journal.admit(
      request.scope,
      request.id,
      { type: "catalog.create", original: request as unknown as Json },
      canReserve
        ? { checkpoint: { scope: request.scope, value: copy(record) as unknown as Json } }
        : {},
    );
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (!canReserve)
      return Promise.resolve(
        this.options.journal.settle(request.scope, request.id, {
          state: "refused",
          result: { reason: "Catalog identity exists or capacity reached" },
        }),
      );
    this.#records.set(scopeKey(request.scope), record);
    this.options.journal.markDispatched(request.scope, request.id);
    const work = this.#own(
      Promise.resolve().then(async () => {
        try {
          return this.#evidence(record, await this.options.host(request).create(copy(request)));
        } catch {
          return this.#evidence(record, { state: "unknown" });
        }
      }),
    );
    this.#publish();
    return work;
  }
  #evidence(retained: Record, evidence: CreationEvidence): Receipt {
    // A read may complete after another reconciliation or metadata write.
    const record = this.#get(retained.entry.scope);
    if (record.entry.creation === "created" || record.entry.creation === "refused")
      return this.options.journal.read(record.entry.scope, record.original.id)!;
    const next = copy(record);
    let outcome: { state: "unknown" } | { state: "succeeded" | "refused"; result: Json } = {
      state: "unknown",
    };
    if (evidence.state === "created") {
      if (
        scopeKey(evidence.binding.scope) !== scopeKey(record.entry.scope) ||
        !evidence.binding.nativeSession ||
        !Number.isSafeInteger(evidence.binding.generation) ||
        evidence.binding.generation < 1
      )
        throw new Error("Native binding fenced");
      next.entry.binding = copy(evidence.binding);
      next.entry.creation = "created";
      next.entry.revision++;
      outcome = {
        state: "succeeded",
        result: {
          revision: next.entry.revision,
          binding: copy(next.entry.binding) as unknown as Json,
        },
      };
    } else if (evidence.state === "refused") {
      next.entry.creation = "refused";
      next.entry.revision++;
      outcome = { state: "refused", result: { reason: "Host positively refused original Create" } };
    } else next.entry.creation = "unknown";
    const receipt = this.#settle(next, record.original.id, outcome);
    this.#records.set(scopeKey(record.entry.scope), next);
    this.#publish();
    return receipt;
  }
  /** Exact read-only reconciliation remains useful after a timeout or restart. */
  reconcile(scope: SessionScope): Promise<Receipt> {
    const record = this.#get(scope);
    if (record.entry.creation === "created" || record.entry.creation === "refused")
      return Promise.resolve(this.options.journal.read(scope, record.original.id)!);
    const receipt = this.options.journal.read(scope, record.original.id);
    if (!receipt) throw new Error("Catalog original is missing");
    if (receipt.state === "admitted") {
      // This owner cannot have invoked a Host without its dispatch commit.
      // Release only this proven never-dispatched workflow; never send it now.
      const next = copy(record);
      next.entry.creation = "refused";
      next.entry.revision++;
      const result = this.#settle(next, record.original.id, {
        state: "refused",
        result: { reason: "Create was not dispatched before interruption" },
      });
      this.#records.set(scopeKey(scope), next);
      this.#publish();
      return Promise.resolve(result);
    }
    return this.#own(
      Promise.resolve().then(async () => {
        try {
          return this.#evidence(
            record,
            await this.options.host(record.original).read(copy(record.original)),
          );
        } catch {
          return this.#evidence(record, { state: "unknown" });
        }
      }),
    );
  }
  patch(scope: SessionScope, operationId: string, revision: number, input: CatalogPatch): Receipt {
    const record = this.#get(scope);
    const patch = z
      .object({
        name: z.string().max(512).optional(),
        watched: z.boolean().optional(),
        data: json.optional(),
      })
      .strict()
      .parse(cloneJson(input as Json, 65536)) as CatalogPatch;
    const admitted = this.options.journal.admit(scope, operationId, {
      type: "catalog.patch",
      revision,
      patch: patch as Json,
    });
    if (!admitted.fresh) return admitted.receipt;
    if (!Number.isSafeInteger(revision) || record.entry.revision !== revision)
      return this.options.journal.settle(scope, operationId, {
        state: "refused",
        result: { reason: "Metadata revision changed" },
      });
    this.options.journal.markDispatched(scope, operationId);
    const next = copy(record);
    Object.assign(next.entry, patch);
    next.entry.revision++;
    const result = this.#settle(next, operationId, {
      state: "succeeded",
      result: { revision: next.entry.revision },
    });
    this.#records.set(scopeKey(scope), next);
    this.#publish();
    return result;
  }
  publishArchive(
    scope: SessionScope,
    operationId: string,
    hostOriginalId: string,
    generation: number,
  ): Promise<Receipt> {
    const record = this.#get(scope);
    id.parse(hostOriginalId);
    z.number().int().positive().parse(generation);
    const admitted = this.options.journal.admit(scope, operationId, {
      type: "catalog.archive",
      hostOriginalId,
      generation,
    });
    if (!admitted.fresh) return Promise.resolve(admitted.receipt);
    if (!record.entry.binding || record.entry.creation !== "created")
      return Promise.resolve(
        this.options.journal.settle(scope, operationId, {
          state: "refused",
          result: { reason: "No native binding" },
        }),
      );
    return this.reconcileArchive(scope, operationId);
  }
  /** Read the saved Host Archive identity, not Create or a replacement command. */
  reconcileArchive(inputScope: SessionScope, operationId: string): Promise<Receipt> {
    const record = this.#get(inputScope),
      scope = copy(record.entry.scope),
      receipt = this.options.journal.read(scope, operationId);
    if (!receipt) throw new Error("Catalog Archive original is missing");
    // Terminal request payloads have been retired. The immutable receipt is final.
    if (receipt.state === "succeeded" || receipt.state === "refused")
      return Promise.resolve(receipt);
    const original = archiveSchema.parse(this.options.journal.request(scope, operationId));
    const key = JSON.stringify([scopeKey(scope), operationId]);
    const retained = this.#archiveReads.get(key);
    if (retained) return retained;
    this.options.journal.markDispatched(scope, operationId);
    // Queue after installing ownership, including when a structural port calls
    // synchronously back into this owner. No Host mutation is reachable here.
    const work = this.#own(
      Promise.resolve().then(async () => {
        let proof: boolean;
        try {
          proof = await this.options
            .host(record.original)
            .readArchive(copy(scope), original.hostOriginalId, original.generation);
        } catch {
          return this.options.journal.settle(scope, operationId, { state: "unknown" });
        }
        if (!proof) return this.options.journal.settle(scope, operationId, { state: "unknown" });
        // Preserve a concurrent CAS rename; only the Archive fact is owned here.
        const next = copy(this.#get(scope));
        if (!next.entry.archived) {
          next.entry.archived = true;
          next.entry.revision++;
        }
        const result = this.#settle(next, operationId, {
          state: "succeeded",
          result: { revision: next.entry.revision, archived: true },
        });
        this.#records.set(scopeKey(scope), next);
        this.#publish();
        return result;
      }),
    );
    this.#archiveReads.set(key, work);
    void work.finally(() => this.#archiveReads.delete(key)).catch(() => {});
    return work;
  }
  readiness(): boolean {
    return !this.#actual.size;
  }
  close(): void {
    if (this.#closed) return;
    if (!this.readiness()) throw new Error("Catalog retains original work");
    this.#closed = true;
    this.#listeners.clear();
    owners.delete(this.options.journal.writerIdentity);
  }
}
