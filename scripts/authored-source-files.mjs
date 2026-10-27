import { execFileSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { resolve } from "node:path";

/** Git owns the authored-source boundary; ignored dependency/cache trees stay out. */
export function authoredSourceFiles(root) {
  const paths = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  ).split("\0").filter(Boolean);
  return [...new Set(paths)]
    .map((path) => resolve(root, path))
    // A tracked deletion has no working source; match the old walk's file-only boundary.
    .filter((path) => lstatSync(path, { throwIfNoEntry: false })?.isFile());
}
