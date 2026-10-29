import assert from "node:assert/strict";
import test from "node:test";
import { request, createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startReference, createReference } from "../../src/reference/server/application.js";
import { OriginalReader, OriginalJournal } from "../../src/storage/index.js";
import type { CreateRequest } from "../../src/catalog/index.js";

function raw(
  url: string,
  method: string,
  host?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const call = request(
      url,
      { method, ...(host === undefined ? {} : { headers: { host } }), agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (value) => {
          body += value;
        });
        response.once("end", () => resolve({ status: response.statusCode!, body }));
      },
    );
    call.once("error", reject);
    call.end();
  });
}

test(
  "reference Root/Host authority, immutable native binding, startup and malformed HTTP remain independently owned",
  { timeout: 100000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-reference19-"));
    const app = await startReference({ directory });
    try {
      assert.equal(app.catalog.list(app.viewer).length, 2);
      assert.equal(app.scripted.counts().allocated, 2);
      assert.equal(app.bootstrap.scopes.length, 2);
      assert.equal(app.bootstrap.previews?.length, 5);
      assert.equal(
        app.scripted.slots.values().next().value!.window.getSnapshot().olderEdge.state,
        "unknown",
      );
      const rootReader = new OriginalReader(join(directory, "root.sqlite")),
        hostReader = new OriginalReader(join(directory, "sessions.sqlite"));
      try {
        const first = app.bootstrap.scopes[0]!.scope;
        assert.equal(rootReader.read(first, "create:first")?.state, "succeeded");
        assert.equal(hostReader.read(first, "create:first")?.state, "succeeded");
        assert.notEqual(
          rootReader.read(first, "create:first")?.requestHash,
          hostReader.read(first, "create:first")?.requestHash,
        );
      } finally {
        rootReader.close();
        hostReader.close();
      }
      const creation = { session: "third", id: "root:create:third", name: "Third conversation" };
      const created = await app.createConversation(creation),
        scope = { ...app.bootstrap.scopes[0]!.scope, session: creation.session };
      assert.equal(created.state, "succeeded");
      const initial = app.catalog.get(scope)!.binding!;
      const original: CreateRequest = {
        scope,
        id: creation.id,
        name: creation.name,
        workspace: { cwd: directory },
        selection: { model: "scripted-small", mode: "agent", effort: "low" },
        target: {
          owner: app.bootstrap.route.owner,
          nativeKind: "scripted",
          contractId: app.bootstrap.expected.contractId,
          contractVersion: app.bootstrap.expected.contractVersion,
        },
      };
      await app.sessions.stop(scope, "stop:first-lifetime", initial.generation);
      await app.sessions.reopen(scope, "reopen:third", initial.generation);
      assert.equal(app.sessions.state(scope).generation, initial.generation + 1);
      const beforeRead = app.scripted.counts().allocated;
      assert.deepEqual(
        await app.hostCreation.read(original),
        { state: "created", binding: initial },
        "Create receipt retains the opened lifetime rather than deriving the current one",
      );
      await assert.rejects(
        app.hostCreation.read({ ...original, selection: { model: "another" } }),
        /original fenced/,
      );
      assert.deepEqual(await app.createConversation(creation), created);
      assert.equal(app.scripted.counts().allocated, beforeRead);
      await app.sessions.stop(scope, "stop:second-lifetime", initial.generation + 1);
      await app.sessions.archive(scope, "host:archive:third", initial.generation + 1);
      assert.equal(
        (
          await app.catalog.publishArchive(
            scope,
            "root:archive:third",
            "host:archive:third",
            initial.generation + 1,
          )
        ).state,
        "succeeded",
      );
      assert.equal(app.catalog.get(scope)?.archived, true);
      await assert.rejects(
        app.hostCreation.readArchive(scope, "host:archive:third", initial.generation),
        /original fenced/,
      );

      assert.equal((await fetch(new URL("/trpc/topology", app.url))).status, 401);
      const bootstrap = await fetch(new URL("/bootstrap", app.url));
      assert.equal(bootstrap.status, 200);
      const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      assert.equal(
        (await fetch(new URL("/trpc/topology", app.url), { headers: { cookie } })).status,
        200,
      );
      for (const [method, host] of [
        ["TRACE", undefined],
        ["GET", "["],
        ["GET", "bad host"],
      ] as const) {
        const response = await raw(new URL("/bootstrap", app.url).href, method, host);
        assert.equal(response.status, 400);
        assert.deepEqual(JSON.parse(response.body), { error: "INVALID" });
        assert.equal(
          (await fetch(new URL("/bootstrap", app.url))).status,
          200,
          "malformed input cannot kill the listener",
        );
      }
      const nativeBeforeDisconnect = app.scripted.counts();
      app.disconnectViewers();
      assert.equal((await raw(new URL("/bootstrap", app.url).href, "GET")).status, 200);
      assert.deepEqual(
        app.scripted.counts(),
        nativeBeforeDisconnect,
        "viewer socket loss owns no native mutation",
      );
      const beforeHelp = await readdir(directory);
      const help = spawnSync(
        process.execPath,
        [fileURLToPath(new URL("../../src/reference/cli.js", import.meta.url)), "--help"],
        { cwd: directory, env: { HOME: directory }, encoding: "utf8", timeout: 10000 },
      );
      assert.equal(help.status, 0, help.stderr);
      assert.match(help.stdout, /Model-free|model-free/);
      assert.match(help.stdout, /explicit application/);
      assert.deepEqual(await readdir(directory), beforeHelp, "CLI help imports are inert");
    } finally {
      await app.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test("partial storage and refused listener startup release acquired owners and prove fresh-session Stop", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-startup19-"));
  const root = new OriginalJournal({ filename: join(directory, "root.sqlite") });
  try {
    await assert.rejects(createReference({ directory }));
    const probe = new OriginalJournal({ filename: join(directory, "sessions.sqlite") });
    probe.close();
  } finally {
    root.close();
    await rm(directory, { recursive: true, force: true });
  }
  const next = await mkdtemp(join(tmpdir(), "multiplex-bind19-")),
    listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  assert(address && typeof address !== "string");
  try {
    await assert.rejects(
      startReference({ directory: next, port: address.port }),
      (error: unknown) => error instanceof Error && "code" in error && error.code === "EADDRINUSE",
    );
    const proof = new OriginalJournal({ filename: join(next, "sessions.sqlite") });
    try {
      assert.equal(proof.checkpoints().length, 2);
      for (const record of proof.checkpoints())
        assert.equal((record.value as { phase: string }).phase, "stopped");
    } finally {
      proof.close();
    }
    const rootProbe = new OriginalJournal({ filename: join(next, "root.sqlite") });
    rootProbe.close();
  } finally {
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(next, { recursive: true, force: true });
  }
});
