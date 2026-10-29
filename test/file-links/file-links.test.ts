import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { join, resolve, relative, isAbsolute, basename } from "node:path";
import { tmpdir } from "node:os";
import { z } from "zod";
import { FileStore, type FileCapturePreviewPort } from "../../src/files/node.js";
import { FileError } from "../../src/files/index.js";
import { HostAssetOwner } from "../../src/assets/node.js";
import { HistoryWindow } from "../../src/history/index.js";
import { defineHost, activateHost, hostRouter } from "../../src/host/index.js";
import { HostFileLinks, fileLinkRouter } from "../../src/file-links/node.js";
import { FileLinkResolver, localFileLink } from "../../src/file-links/index.js";
const scope = { connection: "connection", principal: "owner", host: "host", session: "session" },
  run = { scope, generation: 1, nativeSession: "native" };
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-file-links-")),
    workspace = join(directory, "workspace"),
    storePath = join(directory, "store");
  await mkdir(workspace, { mode: 0o700 });
  await mkdir(storePath, { mode: 0o700 });
  const sources = new Map<string, { path: string; mediaType: string }>([
    ["note.txt", { path: join(workspace, "note.txt"), mediaType: "text/plain" }],
    ["refused.txt", { path: join(workspace, "refused.txt"), mediaType: "text/plain" }],
    ["image.png", { path: join(workspace, "image.png"), mediaType: "image/png" }],
    ["page.html", { path: join(workspace, "page.html"), mediaType: "text/html" }],
    ["document.pdf", { path: join(workspace, "document.pdf"), mediaType: "application/pdf" }],
    ["../outside", { path: resolve(workspace, "../outside"), mediaType: "text/plain" }],
    ["symlink", { path: join(workspace, "symlink"), mediaType: "text/plain" }],
  ]);
  await writeFile(join(workspace, "note.txt"), "First immutable content");
  await writeFile(
    join(workspace, "image.png"),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0kAAAAASUVORK5CYII=",
      "base64",
    ),
  );
  await writeFile(
    join(workspace, "page.html"),
    "<h1>Preview</h1><script>parent.invalid=true</script>",
  );
  await writeFile(join(workspace, "document.pdf"), "%PDF-1.4\n%%EOF");
  await writeFile(join(directory, "outside"), "private");
  await symlink(join(directory, "outside"), join(workspace, "symlink"));
  await writeFile(join(workspace, "refused.txt"), "Must remain private after authority refusal");
  let current = run,
    refused = false;
  const files = await FileStore.open({
    directory: storePath,
    paths: {
      async resolve(actualScope, sourceKey) {
        assert.deepEqual(actualScope, scope);
        if (refused) throw new FileError("FENCED");
        const source = sources.get(sourceKey);
        if (!source) throw new FileError("FENCED");
        const suffix = relative(workspace, source.path);
        if (suffix.startsWith("..") || isAbsolute(suffix)) throw new FileError("FENCED");
        return { ...source, name: basename(source.path) };
      },
    },
  });
  const assets = new HostAssetOwner({ store: files }),
    window = new HistoryWindow({ run, attachment: "attachment", stream: "root" });
  window.update({
    rows: [
      {
        id: "row",
        kind: "assistant",
        lifecycle: "completed",
        body: { kind: "complete", text: [...sources.keys()].join(" "), evidence: "native" },
        native: {},
      },
    ],
  });
  const capture: FileCapturePreviewPort = {
    resourceIdentity: assets.resourceIdentity,
    capturePreview: (input, current) => assets.capturePreview(input, current),
  };
  assert.equal(capture.resourceIdentity, files.resourceIdentity);
  const links = new HostFileLinks({
    files: capture,
    current: () => current,
    history: () => ({ scope: window.scope, getSnapshot: () => window.getSnapshot() }),
    source({ link, row }) {
      assert.equal(row.id, "row");
      if (
        row.body.kind === "unavailable" ||
        !row.body.text.includes(link.href) ||
        !sources.has(link.href)
      )
        throw new FileError("FENCED");
      return link.href;
    },
  });
  const route = { authority: "root", host: "host", owner: "owner", routeEpoch: "epoch" },
    identity = { id: "fixture", version: 1, recordVersion: 1 };
  const host = await activateHost(
    defineHost({
      contract: { id: "fixture", version: 1 },
      harness: { identity, nativeKind: "fixture", capabilities: [] },
      lifecycle: () => ({
        identity,
        createInput: z.null(),
        public: { host: z.null(), session: z.null() },
        open: () => ({
          sessions: null,
          router: hostRouter({}),
          readiness: () => ({ ready: true as const }),
          close() {},
        }),
      }),
      extensions: () => ({
        links: {
          identity,
          public: { host: z.null(), session: z.null() },
          router: fileLinkRouter(links),
          readiness: () =>
            links.readiness()
              ? { ready: true as const }
              : { ready: false as const, reasons: ["File capture pending"] },
          close: () => links.close(),
        },
      }),
    }),
    {
      route,

      authenticate() {
        return {
          identity: { connection: scope.connection, principal: scope.principal, actions: ["read"] },
          route,
        };
      },
    },
  );
  const caller = host.router.createCaller(
    await host.context({ proof: null, expected: host.manifest }),
  );
  return {
    files,
    assets,
    links,
    caller,
    workspace,
    refuse() {
      refused = true;
    },
    replaceRun() {
      current = { ...run, generation: 2 };
    },
    request: (href: string) => ({ run, stream: "root", rowId: "row", href }),
    async close() {
      await host.close();
      await assets.close();
      window.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
test("real FileStore and authenticated typed Host router capture text/image/HTML/PDF and reject path authority escapes", async () => {
  const f = await fixture();
  try {
    for (const [href, kind] of [
      ["note.txt", "text"],
      ["image.png", "image"],
      ["page.html", "html"],
      ["document.pdf", "pdf"],
    ]) {
      const result = await f.caller.extensions.links.resolve(f.request(href!));
      assert.equal(result.state, "ready");
      if (result.state === "ready") {
        assert.equal(result.preview.kind, kind);
        assert.equal("path" in result.preview.file, false);
        if (result.preview.kind === "html") assert.equal(result.preview.sandbox, "");
      }
    }
    await writeFile(join(f.workspace, "note.txt"), "Changed source");
    const retained = await f.caller.extensions.links.resolve(f.request("note.txt"));
    assert.equal(retained.state, "ready");
    if (retained.state === "ready" && retained.preview.kind === "text")
      assert.equal(retained.preview.text, "First immutable content");
    for (const href of [
      "../outside",
      "symlink",
      "javascript:alert(1)",
      "https://example.test/file",
    ])
      assert.deepEqual(await f.caller.extensions.links.resolve(f.request(href)), {
        state: "unavailable",
      });
    await assert.rejects(
      f.caller.extensions.links.resolve({
        ...f.request("note.txt"),
        run: { ...run, scope: { ...scope, principal: "foreign" } },
      }),
    );
    f.refuse();
    assert.deepEqual(await f.caller.extensions.links.resolve(f.request("refused.txt")), {
      state: "unavailable",
    });
    f.replaceRun();
    await assert.rejects(f.caller.extensions.links.resolve(f.request("note.txt")), /fenced/);
    await f.links.close();
    assert(
      f.files.usage().entries > 0,
      "Closing borrowed links leaves their actual file owner open",
    );
  } finally {
    await f.close();
  }
});
test("browser resolver coalesces capture, bounds pending handouts and waits for late real lease cleanup", async () => {
  const f = await fixture();
  let captures = 0;
  const resolver = new FileLinkResolver({
    identity: scope,
    files: f.files,
    capture: (link) => {
      captures++;
      return f.caller.extensions.links.resolve(link);
    },
    maxPending: 1,
  });
  try {
    const [a, b] = await Promise.all([
      resolver.resolve(f.request("note.txt")),
      resolver.resolve(f.request("note.txt")),
    ]);
    assert.equal(captures, 1);
    assert.equal(a.state, "ready");
    assert.equal(b.state, "ready");
    assert.equal(f.files.usage().leases, 2);
    if (a.state === "ready") await a.release();
    assert.equal(f.files.usage().leases, 1);
    await resolver.close();
    assert.equal(f.files.usage().leases, 0);
    assert.equal(resolver.readiness(), true);
    assert.deepEqual(await resolver.resolve(f.request("note.txt")), { state: "unavailable" });
    assert.equal(localFileLink("https://example.test:123"), false);
    assert.equal(localFileLink("file:///workspace/note.txt"), true);
    assert.equal(localFileLink("note.txt:12"), true);
    const acquired = deferred(),
      allow = deferred();
    const late = new FileLinkResolver({
      identity: scope,
      maxLeases: 1,
      capture: (link) => f.caller.extensions.links.resolve(link),
      files: {
        async acquire(owner, file) {
          const lease = await f.files.acquire(owner, file);
          acquired.resolve();
          await allow.promise;
          return lease;
        },
      },
    });
    let closing: Promise<void> | undefined;
    try {
      const pending = late.resolve(f.request("note.txt"));
      await acquired.promise;
      assert.equal(f.files.usage().leases, 1);
      assert.deepEqual(await late.resolve(f.request("note.txt")), { state: "unavailable" });
      let closed = false;
      closing = late.close().then(() => {
        closed = true;
      });
      await Promise.resolve();
      assert.equal(closed, false);
      assert.equal(late.readiness(), false);
      allow.resolve();
      assert.deepEqual(await pending, { state: "unavailable" });
      await closing;
      assert.equal(f.files.usage().leases, 0);
      assert.equal(late.readiness(), true);
    } finally {
      allow.resolve();
      await (closing ?? late.close());
    }
  } finally {
    await resolver.close();
    await f.close();
  }
});
