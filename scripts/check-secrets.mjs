import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { repositoryRoot } from "./release-config.mjs";

const patterns = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{40,})\b/],
  ["npm token", /\bnpm_[A-Za-z0-9]{20,}\b/],
  ["OpenAI-style secret", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ["committed npm auth", /\/\/(?:npm\.pkg\.github\.com|registry\.npmjs\.org)\/:_authToken\s*=\s*(?!\$\{)[^\s]+/],
];

const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  cwd: repositoryRoot,
  encoding: "utf8",
}).split("\0").filter(Boolean);

const findings = [];
for (const path of files) {
  if (path === "scripts/check-secrets.mjs") continue;
  let contents;
  try {
    contents = readFileSync(resolve(repositoryRoot, path), "utf8");
  } catch {
    continue;
  }
  if (contents.includes("\0")) continue;
  for (const [label, pattern] of patterns) {
    if (pattern.test(contents)) findings.push(`${path}: ${label}`);
  }
}

if (findings.length > 0) {
  throw new Error(`possible committed secrets:\n${findings.join("\n")}`);
}
console.log(`No high-confidence secrets found in ${files.length} tracked files.`);
