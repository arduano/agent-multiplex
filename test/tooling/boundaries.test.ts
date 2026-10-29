import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

test("the actual boundary command follows TSX edges and refuses cycles and missing sources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-boundaries-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "src", "sample"), { recursive: true });
    await copyFile(resolve("scripts/boundaries.ts"), join(directory, "scripts/boundaries.ts"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    // Qualification tooling is explicit; this is a source-graph oracle, not
    // an independent dependency-installation claim.
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), join(directory, "scripts/boundaries.ts")],
        { cwd: directory, encoding: "utf8", timeout: 10_000 },
      );
    await writeFile(join(directory, "src/index.ts"), 'export * from "./sample/index.js";');
    await writeFile(join(directory, "src/sample/index.tsx"), 'export * from "./child.js";');
    await writeFile(join(directory, "src/sample/child.tsx"), "export const child = true;");
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    await writeFile(join(directory, "src/sample/child.tsx"), 'export * from "./index.js";');
    const cycle = run();
    assert.notEqual(cycle.status, 0);
    assert.match(cycle.stderr, /Runtime import cycle/);
    await writeFile(join(directory, "src/sample/child.tsx"), 'export * from "./missing.js";');
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.match(missing.stderr, /Missing source import/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("portable package exports cannot load server implementations or Node facades", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-portable-boundaries-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "src/sample/server"), { recursive: true });
    await mkdir(join(directory, "src/sample/node"));
    await copyFile(resolve("scripts/boundaries.ts"), join(directory, "scripts/boundaries.ts"));
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({
        type: "module",
        exports: {
          ".": { types: "./dist/sample/index.d.ts", import: "./dist/sample/index.js" },
          "./sample/node": {
            node: { import: "./dist/sample/node.js" },
            default: null,
          },
          "./sample/peer": {
            node: { import: "./dist/sample/node/peer.js" },
            default: null,
          },
        },
      }),
    );
    await writeFile(
      join(directory, "src/sample/server/helper.ts"),
      'import { readFile } from "node:fs/promises"; export const server = readFile; export type ServerType = string; export const configured = (path: string) => import(path);',
    );
    await writeFile(join(directory, "src/sample/node.ts"), 'export * from "./server/helper.js";');
    await writeFile(
      join(directory, "src/sample/node/peer.ts"),
      'import "@example/native-transport"; export const peer = true;',
    );
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), join(directory, "scripts/boundaries.ts")],
        { cwd: directory, encoding: "utf8", timeout: 10_000 },
      );
    const check = async (source: string) => {
      await writeFile(join(directory, "src/sample/index.ts"), source);
      return run();
    };
    const valid = await check(
      'import type { ServerType } from "./server/helper.js"; export type { ServerType }; export const portable = true;',
    );
    assert.equal(valid.status, 0, valid.stderr);
    for (const source of [
      'export * from "./server/helper.js";',
      'import { type ServerType } from "./server/helper.js"; export type { ServerType };',
      'export { type ServerType } from "./server/helper.js";',
      'export const load = () => import("./server/helper.js");',
    ]) {
      const server = await check(source);
      assert.notEqual(server.status, 0, source);
      assert.match(server.stderr, /Portable export reaches server implementation/);
    }
    const facade = await check('export * from "./node.js";');
    assert.notEqual(facade.status, 0);
    assert.match(facade.stderr, /Portable export reaches Node facade/);
    const nodeDirectory = await check('export * from "./node/peer.js";');
    assert.notEqual(nodeDirectory.status, 0);
    assert.match(nodeDirectory.stderr, /Portable export reaches Node implementation/);
    const builtin = await check('export { readFile } from "node:fs/promises";');
    assert.notEqual(builtin.status, 0);
    assert.match(builtin.stderr, /Portable export reaches Node builtin/);
    const computed = await check("export const load = (path: string) => import(path);");
    assert.notEqual(computed.status, 0);
    assert.match(computed.stderr, /Portable export reaches computed dynamic import/);
    const typeBuiltin = await check('export type { Stats } from "node:fs";');
    assert.equal(typeBuiltin.status, 0, typeBuiltin.stderr);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("contracts cannot borrow concrete implementations or disguise a private module entry", async () => {
  const directory = await mkdtemp(join(tmpdir(), "multiplex-contract-boundaries-"));
  try {
    await mkdir(join(directory, "scripts"));
    await mkdir(join(directory, "src/sample/internal"), { recursive: true });
    await mkdir(join(directory, "src/consumer"));
    await copyFile(resolve("scripts/boundaries.ts"), join(directory, "scripts/boundaries.ts"));
    await writeFile(join(directory, "package.json"), '{"type":"module"}');
    await symlink(resolve("node_modules"), join(directory, "node_modules"), "dir");
    const run = () =>
      spawnSync(
        process.execPath,
        ["--import", import.meta.resolve("tsx"), join(directory, "scripts/boundaries.ts")],
        { cwd: directory, encoding: "utf8", timeout: 10_000 },
      );
    await writeFile(
      join(directory, "src/sample/internal/index.ts"),
      "export class Owner { private closed = false; }",
    );
    await writeFile(
      join(directory, "src/sample/contracts.ts"),
      "export interface Reader { read(): string }",
    );
    await writeFile(
      join(directory, "src/consumer/index.ts"),
      'import type { Reader } from "../sample/contracts.js"; export type { Reader };',
    );
    const valid = run();
    assert.equal(valid.status, 0, valid.stderr);
    await writeFile(
      join(directory, "src/sample/contracts.ts"),
      'import type { Owner } from "./internal/index.js"; export type Reader = Owner;',
    );
    const nominal = run();
    assert.notEqual(nominal.status, 0);
    assert.match(nominal.stderr, /Contract reaches implementation/);
    await writeFile(
      join(directory, "src/sample/contracts.ts"),
      "export interface Reader { read(): string }",
    );
    await writeFile(
      join(directory, "src/consumer/index.ts"),
      'import type { Owner } from "../sample/internal/index.js"; export type { Owner };',
    );
    const disguised = run();
    assert.notEqual(disguised.status, 0);
    assert.match(disguised.stderr, /Use a declared module entry/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
