import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertPrivateFileSync, ensurePrivateDirectorySync } from "../src/private-path.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = mkdtempSync(join(tmpdir(), "multiplex-private-path-")); roots.push(root); return root; }

describe.skipIf(process.platform === "win32")("POSIX private state helper", () => {
  it("creates private paths and validates existing directories without silently repairing them", () => {
    const directory = join(fixture(), "nested", "state");
    ensurePrivateDirectorySync(directory);
    expect(statSync(directory).mode & 0o777).toBe(0o700);
    ensurePrivateDirectorySync(directory);
    chmodSync(directory, 0o755);
    expect(() => ensurePrivateDirectorySync(directory)).toThrow("0700");
    expect(statSync(directory).mode & 0o777).toBe(0o755);
  });

  it("rejects symlinks and protects regular files", () => {
    const root = fixture();
    const file = join(root, "private.json");
    writeFileSync(file, "fixture", { mode: 0o644 });
    assertPrivateFileSync(file);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    symlinkSync(file, join(root, "file-link"));
    symlinkSync(root, join(root, "dir-link"));
    expect(() => assertPrivateFileSync(join(root, "file-link"))).toThrow("non-symlink");
    expect(() => ensurePrivateDirectorySync(join(root, "dir-link"))).toThrow("non-symlink");
  });
});
