import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request } from "node:http";
import { startApplication } from "../application/server.js";

test("local application rejects rebinding Host and cross-origin credential issuance before serving any capability", async () => {
  const directory = await mkdtemp(join(tmpdir(), "v8-app-authority-"));
  let app: Awaited<ReturnType<typeof startApplication>> | undefined;
  try {
    await writeFile(join(directory, "index.html"), "<html><body>owned application</body></html>");
    app = await startApplication({ directory, assets: directory });
    const read = (path: string, headers: Record<string, string> = {}) => new Promise<{ status: number; cookie: boolean }>((resolve, reject) => {
      const req = request(new URL(path, app!.url), { headers }, response => {
        response.resume(); response.once("end", () => resolve({ status: response.statusCode!, cookie: !!response.headers["set-cookie"] }));
      });
      req.once("error", reject); req.end();
    });
    for (const path of ["/", "/configuration", "/v8"]) {
      assert.deepEqual(await read(path, { host: "rebound.invalid" }), { status: 403, cookie: false });
      assert.deepEqual(await read(path, { origin: "http://cross-origin.invalid" }), { status: 403, cookie: false });
    }
    assert.deepEqual(await read("/v8"), { status: 401, cookie: false });
    assert.deepEqual(await read("/"), { status: 200, cookie: true });
    assert.ok(app.stats().every(value => value.opens === 0 && value.sends === 0 && value.bodyReads === 0));
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
