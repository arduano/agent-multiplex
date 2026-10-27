import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CatalogAuthority } from "../src/authority/catalog.js";
import type { CatalogScope, CreateRequest, HostCreationPort, HostCreationStatus, HostTarget } from "../src/contracts/types.js";
export const scope: CatalogScope = { connection: "connection", principal: "account", authority: "root" };
export const target: HostTarget = { host: "host", owner: "durable-domain", kind: "codex", placement: "shared" };
export const request = (id = "create-a", session = "a"): CreateRequest => ({ scope, id, session, target, metadata: { name: "Original", cwd: "/work/original" }, selection: { kind: "codex", model: "model-a" } });
export const defer = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; };
export const until = async (check: () => boolean | Promise<boolean>): Promise<void> => { const end = Date.now() + 20000; while (!await check()) { if (Date.now() > end) throw new Error("bounded condition expired"); await new Promise(r => setTimeout(r, 5)); } };
export class CreationFixture implements HostCreationPort {
  readonly creates: CreateRequest[] = []; readonly reads: CreateRequest[] = []; readonly statuses = new Map<string, HostCreationStatus>(); gate: Promise<void> | undefined; lose = false;
  readonly archiveReads: { original: CreateRequest; id: string; generation: number }[] = []; readonly archived = new Set<string>(); archiveGate: Promise<boolean> | undefined;
  constructor(readonly target: HostTarget) {}
  async create(original: CreateRequest): Promise<HostCreationStatus> { this.creates.push(original); await this.gate; const status: HostCreationStatus = { state: "created", binding: { nativeSession: `real-${original.session}`, generation: 1, kind: this.target.kind, placement: this.target.placement } }; this.statuses.set(original.id, status); if (this.lose) throw new Error("reply lost"); return status; }
  async read(original: CreateRequest): Promise<HostCreationStatus> { this.reads.push(original); return this.statuses.get(original.id) ?? { state: "unknown" }; }
  async readArchive(original: CreateRequest, id: string, generation: number): Promise<boolean> { this.archiveReads.push({ original, id, generation }); return this.archiveGate ?? this.archived.has(JSON.stringify([original.session, id, generation])); }
}
export async function fixture(options: { maxSessions?: number; maxOperations?: number; observationMs?: number } = {}) {
  const directory = await mkdtemp(join(process.env.V8_CATALOG_TMPDIR ?? tmpdir(), "v8-catalog-")); let authority = await CatalogAuthority.open({ directory, scope, observationMs: 10000, ...options }); const host = new CreationFixture(target); authority.register(host);
  return { directory, host, get authority() { return authority; }, async reopen() { await authority.terminate(); authority = await CatalogAuthority.open({ directory, scope, observationMs: 10000, ...options }); authority.register(host); return authority; }, async dispose() { await authority.terminate(); await rm(directory, { recursive: true, force: true }); } };
}
