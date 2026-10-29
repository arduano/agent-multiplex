import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test, type TestContext } from "node:test";

function evaluate(expression: string) {
  return spawnSync(
    "nix",
    [
      "--extra-experimental-features",
      "nix-command",
      "eval",
      "--impure",
      "--json",
      "--expr",
      expression,
    ],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
}

function missingNix(result: ReturnType<typeof evaluate>, context: TestContext): boolean {
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    context.skip("Nix is not installed; separate Nix gate remains required");
    return true;
  }
  return false;
}

test("actual Nix source filter admits build inputs and excludes mutable/private/test inputs and symlinks", async (context) => {
  const source = await readFile(resolve("nix/source-filter.nix"), "utf8");
  const result = evaluate(`let filter = (${source}) "/fixture"; in {
    source = filter "/fixture/src/codex/node.ts" "regular";
    styles = filter "/fixture/src/chat/styles.css" "regular";
    compiler = filter "/fixture/tsconfig.json" "regular";
    build = filter "/fixture/scripts/build.ts" "regular";
    retiredExtractor = filter "/fixture/scripts/nix-dependencies.mjs" "regular";
    cache = filter "/fixture/.cache" "directory";
    dependencies = filter "/fixture/node_modules" "directory";
    state = filter "/fixture/state.json" "regular";
    credentials = filter "/fixture/credentials" "directory";
    tests = filter "/fixture/test" "directory";
    unknownScript = filter "/fixture/scripts/operator.ts" "regular";
    lintConfiguration = filter "/fixture/eslint.config.ts" "regular";
    link = filter "/fixture/src/linked.ts" "symlink";
  }`);
  if (missingNix(result, context)) return;
  assert.equal(
    result.status,
    0,
    JSON.stringify({ signal: result.signal, error: result.error, stderr: result.stderr }),
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    source: true,
    styles: true,
    compiler: true,
    build: true,
    retiredExtractor: false,
    cache: false,
    dependencies: false,
    state: false,
    credentials: false,
    tests: false,
    unknownScript: false,
    lintConfiguration: false,
    link: false,
  });
});

test("actual package admission refuses local/linked/unhashed dependencies before any fetch/build port", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-nix-admission-"));
  // Constructor ports are inert here. The real package expression and its
  // admission checks run; no npm install, fetcher or Nix build is invoked.
  const expression = `let payload = import ${JSON.stringify(resolve("nix/package.nix"))} {
    source = ${JSON.stringify(directory)};
    lib = {
      assertMsg = condition: message: if condition then true else throw message;
      cleanSourceWith = input: input.src;
      licenses.mit = "MIT";
    };
    buildNpmPackage = input: { inherit (input) pname; };
    importNpmLock = { __functor = self: input: null; npmConfigHook = null; };
    nodejs_24.version = "24.19.0";
    nodejs-slim_24.version = "24.19.0";
    makeWrapper = null; autoPatchelfHook = null;
    stdenv.cc.cc.lib = null; musl = null; ncurses = null;
  }; in payload.pname`;
  const manifest = { name: "fixture", version: "1.0.0", dependencies: { fixture: "1.2.3" } };
  const artifact = {
    version: "1.2.3",
    resolved: "https://example.test/fixture-1.2.3.tgz",
    integrity: `sha512-${Buffer.alloc(64).toString("base64")}`,
  };
  const lock = (entry: object) => ({
    lockfileVersion: 3,
    packages: { "": manifest, "node_modules/fixture": entry },
  });
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock(artifact)));
    const accepted = evaluate(expression);
    if (missingNix(accepted, context)) return;
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.equal(JSON.parse(accepted.stdout), "agent-multiplex");
    for (const entry of [
      { ...artifact, integrity: undefined },
      { ...artifact, resolved: "http://example.test/fixture.tgz" },
      { ...artifact, resolved: "file:../mutable" },
      { ...artifact, resolved: "git+https://example.test/repo.git#deadbeef" },
      { ...artifact, link: true },
    ]) {
      await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock(entry)));
      const refused = evaluate(expression);
      assert.notEqual(refused.status, 0);
      assert.match(refused.stderr, /requires HTTPS\/SRI npm lock artifacts/);
    }
    await writeFile(join(directory, "package-lock.json"), JSON.stringify(lock(artifact)));
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ ...manifest, dependencies: { fixture: "file:../mutable" } }),
    );
    const refused = evaluate(expression);
    assert.notEqual(refused.status, 0);
    assert.match(
      refused.stderr,
      /requires exact declared versions or matching pinned HTTPS artifacts/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
