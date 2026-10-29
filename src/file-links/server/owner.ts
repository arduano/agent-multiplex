import type { HostFileLinkOptions, HostFileLinkOwner } from "../node-contracts.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalJson, cloneJson, type Json, type RunRef } from "../../protocol/index.js";
import { hostProcedure, hostRouter } from "../../host/index.js";
import {
  localFileLink,
  type FileLink,
  type FileLinkResolvePort,
  type FileLinkResult,
} from "../contracts.js";
const id = z.string().min(1).max(256),
  scope = z.object({ connection: id, principal: id, host: id, session: id }).strict();
const request = z
  .object({
    run: z.object({ scope, generation: z.number().int().positive(), nativeSession: id }).strict(),
    stream: id,
    rowId: z.string().min(1).max(2048),
    href: z.string().min(1).max(8192),
  })
  .strict();
const same = (a: RunRef, b: RunRef) =>
  canonicalJson(a as unknown as Json, 8192).json === canonicalJson(b as unknown as Json, 8192).json;
export class HostFileLinks implements HostFileLinkOwner {
  readonly #entries = new Map<string, Promise<FileLinkResult>>();
  readonly #actual = new Set<Promise<unknown>>();
  #closed = false;
  constructor(private readonly options: HostFileLinkOptions) {
    for (const [value, max] of [
      [options.maxEntries ?? 64, 256],
      [options.maxPending ?? 2, 8],
    ])
      if (!Number.isSafeInteger(value) || value! < 1 || value! > max!)
        throw Error("Invalid Host file-link bounds");
  }
  #current(link: FileLink) {
    const current = this.options.current(link.run.scope);
    if (this.#closed || !current || !same(current, link.run)) throw Error("File-link run fenced");
  }
  resolve(input: FileLink): Promise<FileLinkResult> {
    const link = request.parse(cloneJson(input as unknown as Json, 16384));
    this.#current(link);
    if (!localFileLink(link.href)) return Promise.resolve({ state: "unavailable" });
    const window = this.options.history(link.run, link.stream);
    if (!same(window.scope.run, link.run) || window.scope.stream !== link.stream)
      throw Error("File-link history fenced");
    const row = window.getSnapshot().rows.find((value) => value.id === link.rowId);
    if (!row) return Promise.resolve({ state: "unavailable" });
    const key = canonicalJson(link as unknown as Json, 16384).json,
      old = this.#entries.get(key);
    if (old) return old;
    if (this.#actual.size >= (this.options.maxPending ?? 2))
      return Promise.resolve({ state: "unavailable" });
    if (this.#entries.size >= (this.options.maxEntries ?? 64)) {
      const victim = [...this.#entries].find(([, promise]) => !this.#actual.has(promise));
      if (!victim) return Promise.resolve({ state: "unavailable" });
      this.#entries.delete(victim[0]);
    }
    const work = Promise.resolve().then(async (): Promise<FileLinkResult> => {
      try {
        const sourceKey = await this.options.source({ link, row });
        this.#current(link);
        const id = `link-${createHash("sha256").update(key).digest("hex")}`;
        const result = await this.options.files.capturePreview(
          { scope: link.run.scope, sourceKey, id },
          () => this.#current(link),
        );
        this.#current(link);
        return { state: "ready", preview: result };
      } catch {
        return { state: "unavailable" };
      }
    });
    this.#entries.set(key, work);
    this.#actual.add(work);
    void work.finally(() => this.#actual.delete(work)).catch(() => {});
    return work;
  }
  readiness(): boolean {
    return !this.#actual.size;
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#actual]);
    this.#entries.clear();
  }
}
export function fileLinkRouter(owner: FileLinkResolvePort) {
  return hostRouter({
    resolve: hostProcedure.input(request).query(({ ctx, input }) => {
      if (
        input.run.scope.connection !== ctx.identity.connection ||
        input.run.scope.principal !== ctx.identity.principal ||
        input.run.scope.host !== ctx.route.host ||
        (ctx.session &&
          (ctx.session.id !== input.run.scope.session ||
            ctx.session.generation !== input.run.generation))
      )
        throw Error("File-link actor fenced");
      return owner.resolve(input);
    }),
  });
}
