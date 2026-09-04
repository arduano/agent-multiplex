import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { repositoryRoot } from "./release-config.mjs";

const files = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "*.md"],
  { cwd: repositoryRoot, encoding: "utf8" },
).trim().split("\n").filter(Boolean);
const failures = [];

for (const file of files) {
  const absolute = resolve(repositoryRoot, file);
  if (!existsSync(absolute)) continue;
  const markdown = readFileSync(absolute, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const target = match[1];
    if (/^(?:https?:|mailto:|#|\/)/.test(target)) continue;
    const localPath = decodeURIComponent(target.split("#", 1)[0]);
    if (!existsSync(resolve(dirname(absolute), localPath))) {
      failures.push(`${file} -> ${target}`);
    }
  }
  if ((markdown.match(/^```/gm) ?? []).length % 2 !== 0) {
    failures.push(`${file} -> unbalanced code fences`);
  }
}

if (failures.length > 0) {
  throw new Error(`documentation validation failed:\n${failures.join("\n")}`);
}
console.log(`Checked ${files.length} Markdown files; local links and code fences are valid.`);
