import { transferFixture } from "../assets/transfer-fixture.js";
import { blobSource } from "@arduano/p2prpc-core/files";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReference } from "../../src/reference/node.js";

test("reference lifecycle accepts actual same-scope stored attachment IDs and refuses missing or foreign files before scripted Send", async (t) => {
  const start = performance.now(),
    phase = (name: string) => t.diagnostic(`${name}:${Math.round(performance.now() - start)}ms`);
  const directory = await mkdtemp(join(tmpdir(), "multiplex-attachment-reference-")),
    reference = await createReference({ directory, seed: false });
  phase("reference-created");
  try {
    const [first, second] = reference.bootstrap.scopes,
      scope = first!.scope,
      state = reference.sessions.state(scope);
    assert.ok(state.nativeSession);
    const run = { scope, generation: state.generation, nativeSession: state.nativeSession };
    const upload = async (target: typeof scope, id: string, content: string) => {
      const bytes = Buffer.from(content);
      const file = {
        id,
        name: `${id}.txt`,
        bytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        mediaType: "text/plain",
        retention: "session" as const,
      };
      const admitted = reference.assets.begin(target, file);
      assert.equal(admitted.state, "receiving");
      if (admitted.state !== "receiving") throw new Error("Upload was not admitted");
      const transport = transferFixture(reference.assets, target);
      const transfer = await transport.files.sendFile(
        blobSource(new Blob([bytes]), {
          name: file.name,
          metadata: { session: target.session, file, token: admitted.token },
        }),
      );
      await transfer.result;
      const status = reference.assets.status(target, id);
      if (status.state !== "complete") throw Error("Missing publication");
      return status.file;
    };
    const own = await upload(scope, "input", "input");
    await upload(second!.scope, "foreign", "foreign");
    phase("files-persisted");
    const missing = await reference.sessions.send(
      scope,
      "missing-file",
      { text: "no", attachments: [{ id: "absent" }] },
      run,
    );
    assert.equal(missing.state, "refused");
    phase("missing-refused");
    const foreign = await reference.sessions.send(
      scope,
      "foreign-file",
      { text: "no", attachments: [{ id: "foreign" }] },
      run,
    );
    assert.equal(foreign.state, "refused");
    phase("foreign-refused");
    assert.equal(reference.scripted.counts().sends, 0);
    const good = await reference.sessions.send(
      scope,
      "with-file",
      { text: "use it", attachments: [{ id: own.id }] },
      run,
    );
    assert.equal(good.state, "succeeded");
    phase("owned-file-sent");
    assert.equal(reference.scripted.counts().sends, 1);
    const rows = reference.scripted.slots.values().next().value!.rows;
    const user = rows.find((row) => row.id === "user:with-file")!;
    assert.deepEqual(user.native.assets, [{ id: own.id, state: "ready", file: own }]);
  } finally {
    await reference.close();
    phase("reference-closed");
    await rm(directory, { recursive: true, force: true });
    phase("state-removed");
  }
});
