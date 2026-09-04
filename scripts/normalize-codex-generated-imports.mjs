import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { repositoryRoot } from "./release-config.mjs";

const root = resolve(repositoryRoot, "packages/adapter-codex/src/generated");
let changed = 0;
let visited = 0;

for (const filename of walk(root)) {
  if (extname(filename) !== ".ts") continue;
  visited += 1;
  const before = readFileSync(filename, "utf8");
  const after = before.replace(
    /(\bfrom\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (match, prefix, specifier, suffix) => {
      if (/\.(?:js|json|node)$/.test(specifier)) return match;
      const target = resolve(dirname(filename), specifier);
      const normalized = existsSync(target) && statSync(target).isDirectory()
        ? `${specifier}/index.js`
        : `${specifier}.js`;
      return `${prefix}${normalized}${suffix}`;
    },
  );
  if (after !== before) {
    writeFileSync(filename, after);
    changed += 1;
  }
}

console.log(`Normalized Codex ESM imports in ${changed}/${visited} generated files.`);

function walk(directory) {
  const output = [];
  const pending = [directory];
  while (pending.length) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  return output;
}
