import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { expect, it } from "vitest";

import { authoredSourceFiles } from "../scripts/authored-source-files.mjs";

it("checks tracked and new authored files without entering ignored dependencies or caches", () => {
  const directory = mkdtempSync(join(tmpdir(), "multiplex-source-inventory-"));
  try {
    execFileSync("git", ["init", "--quiet", directory]);
    mkdirSync(join(directory, "src"));
    for (const file of ["src/tracked.ts", "tracked-now-ignored.ts", "deleted.ts"]) {
      writeFileSync(join(directory, file), "export {};\n");
    }
    execFileSync("git", ["add", "--", "."], { cwd: directory });
    writeFileSync(join(directory, ".gitignore"), "node_modules/\n.cache/\ntracked-now-ignored.ts\n");
    unlinkSync(join(directory, "deleted.ts"));
    const unusualName = "src/new name\nsecond line.ts";
    writeFileSync(join(directory, unusualName), "export {};\n");
    symlinkSync("src/tracked.ts", join(directory, "source-link.ts"));
    for (const path of ["primitives/harness/node_modules/sdk", "primitives/harness/.cache/native"]) {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, "third-party.ts"), "dependency/cache contents are not authored source\n");
    }

    expect(authoredSourceFiles(directory).map((path: string) => relative(directory, path)).sort()).toEqual([
      ".gitignore", unusualName, "src/tracked.ts", "tracked-now-ignored.ts",
    ].sort());
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
