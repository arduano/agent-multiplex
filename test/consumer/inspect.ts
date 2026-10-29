/** Copied into the isolated consumer; tooling comes from the pinned tsx/cmd-ts,
 * while every framework/native dependency resolves from that consumer only. */
import assert from "node:assert/strict";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { command, option, run, string, type Type } from "cmd-ts";

type Manifest = {
  name: string;
  version: string;
  exports: Record<string, unknown>;
  dependencies: Record<string, string>;
};
const pathType: Type<string, string> = {
  ...string,
  async from(value) {
    if (value.trim().length === 0) throw Error("An explicit nonempty path is required");
    return value;
  },
};
const cli = command({
  name: "inspect-consumer",
  args: { expectedPath: option({ long: "expected", type: pathType }) },
  handler: async ({ expectedPath }) => {
    const expected = JSON.parse(await readFile(expectedPath, "utf8")) as Manifest;
    assert.equal(process.env.NODE_PATH, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    const effects = { childProcesses: 0, providerRequests: 0, listeners: 0 };
    const child = (await import("node:child_process")).default;
    const denyProcess = (): never => {
      effects.childProcesses++;
      throw Error("Import started a process");
    };
    for (const name of [
      "spawn",
      "spawnSync",
      "exec",
      "execSync",
      "execFile",
      "execFileSync",
      "fork",
    ] as const)
      assert.equal(Reflect.set(child, name, denyProcess), true);
    const http = (await import("node:http")).default,
      https = (await import("node:https")).default;
    const denyRequest = (): never => {
      effects.providerRequests++;
      throw Error("Import sent a request");
    };
    for (const module of [http, https])
      for (const name of ["request", "get"] as const) module[name] = denyRequest;
    globalThis.fetch = (): never => {
      effects.providerRequests++;
      throw Error("Import called fetch");
    };
    const net = (await import("node:net")).default;
    net.Server.prototype.listen = (): never => {
      effects.listeners++;
      throw Error("Import opened a listener");
    };
    syncBuiltinESMExports();
    const frameworkEntry = import.meta.resolve(expected.name);
    const frameworkFile = join(dirname(dirname(fileURLToPath(frameworkEntry))), "package.json");
    const framework = JSON.parse(await readFile(frameworkFile, "utf8")) as Manifest,
      imports: string[] = [];
    assert.equal(framework.version, expected.version);
    for (const entry of Object.keys(framework.exports)) {
      if (entry.endsWith(".css")) continue;
      await import(entry === "." ? framework.name : framework.name + entry.slice(1));
      imports.push(entry);
    }
    const lock = JSON.parse(await readFile("package-lock.json", "utf8")) as {
      packages: Record<string, { resolved?: string }>;
    };
    const p2pEntry = import.meta.resolve("@arduano/p2prpc-core");
    assert.ok(p2pEntry.startsWith(new URL("./node_modules/", import.meta.url).href));
    const p2pRequire = createRequire(p2pEntry),
      resolutions: { name: string; version: string; path: string; source: string }[] = [];
    for (const name of [
      "@arduano/p2prpc-core",
      "@momics/iroh-http-node",
      "@momics/iroh-http-shared",
    ]) {
      const entry =
        name === "@arduano/p2prpc-core" ? fileURLToPath(p2pEntry) : p2pRequire.resolve(name);
      let directory = dirname(entry),
        json: { name: string; version: string } | undefined,
        packageFile: string;
      for (;;) {
        packageFile = join(directory, "package.json");
        try {
          const candidate = JSON.parse(await readFile(packageFile, "utf8")) as {
            name: string;
            version: string;
          };
          if (candidate.name === name) {
            json = candidate;
            break;
          }
        } catch {}
        const parent = dirname(directory);
        assert.notEqual(parent, directory, "Package manifest not found");
        directory = parent;
      }
      const path = packageFile.slice(process.cwd().length + 1).replace(/\/package.json$/, ""),
        source = lock.packages[path]?.resolved;
      assert.equal(
        source,
        expected.dependencies[name],
        `${name} resolved outside its published pin`,
      );
      assert.ok(source);
      resolutions.push({ name, version: json.version, path, source });
    }
    const blake = p2pRequire("@napi-rs/blake-hash") as {
      Blake3Hasher: new () => { digest(format: "hex"): string };
    };
    const digest = new blake.Blake3Hasher().digest("hex");
    assert.equal(digest, "af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262");
    const native = Object.keys(p2pRequire.cache).filter(
      (path) => path.endsWith(".node") && path.includes("blake"),
    );
    assert.ok(native.length, "Actual Blake native binding was not loaded");
    assert.ok(
      native.every((path) => path.startsWith(process.cwd() + "/node_modules/")),
      "Borrowed native binding from outside consumer",
    );
    assert.deepEqual(effects, { childProcesses: 0, providerRequests: 0, listeners: 0 });
    console.log(
      JSON.stringify({
        imports,
        resolutions,
        nativeBlake: { digest, files: native.map((path) => path.slice(process.cwd().length + 1)) },
        effects,
      }),
    );
  },
});
await run(cli, process.argv.slice(2));
