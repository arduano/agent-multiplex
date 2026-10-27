import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const framework = resolve(root, "../..");
const require = createRequire(import.meta.url);
const sha = value => createHash("sha256").update(value).digest("hex");
const artifact = join(root, "artifacts/latest");
await mkdir(artifact, { recursive: true });
async function files(directory) {
  const result = [];
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a,b) => a.name.localeCompare(b.name))) {
    if ([".build", "artifacts", "node_modules", ".git"].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...await files(path)); else if (entry.isFile()) result.push(path);
    else throw new Error("Qualification boundary contains an unsupported file kind");
  }
  return result;
}
const sources = await files(root);
// Core compilation is a closed, browser-safe relative module graph. The separate
// runner/browser harness alone may load Node/Playwright; no vendor SDK is loaded.
for (const path of sources.filter(path => path.includes(`${join(root, "src")}/`) && path.endsWith(".ts"))) {
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(/\bfrom\s+["']([^"']+)["']/g)) {
    if (!match[1].startsWith(".") || !resolve(dirname(path), match[1]).startsWith(join(root, "src") + "/")) throw new Error("Core module escaped its primitive boundary");
  }
  if (/\b(?:import|require|fetch|WebSocket|Worker|eval|Function)\s*\(/.test(source)) throw new Error("Core contains an ambient effect/dynamic import");
}
const manifest = [];
for (const path of sources) manifest.push({ path: relative(root, path), sha256: sha(await readFile(path)) });
manifest.push({ path: "../../package-lock.json", sha256: sha(await readFile(join(framework, "package-lock.json"))) });
manifest.push({ path: "../../package.json", sha256: sha(await readFile(join(framework, "package.json"))) });
const manifestText = JSON.stringify(manifest, null, 2) + "\n";
const sourceHash = sha(manifestText);
await writeFile(join(artifact, "manifest.json"), manifestText);
const log = [];
function gate(name, args, timeout = 45_000) {
  const result = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 2_000_000 });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  log.push(`${name}\n${output}`); process.stdout.write(output);
  if (result.status !== 0 || result.error) throw new Error(`${name} failed`);
  return output;
}
let receipt;
try {
  const compiler = require.resolve("typescript/bin/tsc");
  gate("typecheck", [compiler, "--project", "tsconfig.json", "--noEmit"]);
  gate("build", [compiler, "--project", "tsconfig.json"]);
  const tests = (await files(join(root, "qualification"))).filter(path => path.endsWith(".test.ts")).map(path => join(root, ".build", relative(root,path).replace(/\.ts$/, ".js")));
  tests.push(...(await files(join(root, "qualification"))).filter(path => path.endsWith(".test.mjs")));
  const output = gate("scripted invariant suite", ["--test", "--test-reporter=tap", "--test-timeout=10000", ...tests]);
  const testCount = Number(output.match(/# tests (\d+)/)?.[1]);
  if (!Number.isSafeInteger(testCount) || testCount < 1 || !/# fail 0\b/.test(output) || !/# skipped 0\b/.test(output)) throw new Error("Incomplete scripted test result");
  const { runBrowserQualification } = await import("./browser.mjs");
  const browser = await runBrowserQualification();
  if (!browser.passed || browser.cases.length < 1) throw new Error("Incomplete browser result");
  const after = [];
  for (const path of sources) after.push({ path: relative(root,path), sha256: sha(await readFile(path)) });
  if (JSON.stringify(after) !== JSON.stringify(manifest.slice(0,-2))) throw new Error("Source changed during qualification");
  receipt = {
    status: "scripted-qualified", sourceHash, frameworkHead: execFileSync("git", ["rev-parse", "HEAD"], {cwd:framework, encoding:"utf8"}).trim(),
    startedFrom: "isolated V8 worktree; bootstrap is a reference, not qualification",
    completedAt: new Date().toISOString(), node: process.version, typescript: require("typescript/package.json").version,
    playwright: require("playwright-core/package.json").version, chromium: browser.chromium ?? "own headless Chromium",
    tests: { node: testCount, browser: browser.cases.length, cases: browser.cases },
    boundary: "synthetic and minimized captured native inputs → real codecs → real Host memory → actual retained client; own DOM harness",
    liveNativeOrModelCalls: 0, productIntegration: false, realTransportTested: false,
    matrix: [
      { oracle:"H1", status:"scripted", proof:"exact Codex/Copilot text/tool bytes through zero viewers and reconnect; healthy path has no native read port" },
      { oracle:"H2", status:"scripted", proof:"atomic open/replay, idempotence, missed/slow snapshot fallback including retirement evidence" },
      { oracle:"H3", status:"scripted-and-captured-subset", proof:"missing starts/finals, sequence gaps, exact final healing, read/live races and stale gap fences; no native atomic cursor claim" },
      { oracle:"H4", status:"scripted-and-captured-subset", proof:"two modular pinned-shape codecs plus captured-event regressions; selected live evidence is separate from this zero-call gate" },
      { oracle:"H5", status:"scripted-and-captured-subset", proof:"real acquisition owner and native-shaped read ports; shared cold baseline, private pages, scoped generation/version/order fences, active shrink and opaque single-use persisted cursors; no native media transfer/runtime conformance claim" },
      { oracle:"H6", status:"browser-harness", proof:"actual retained client and DOM anchor/session/pin cases; no product React/virtualizer/mobile keyboard claim" },
      { oracle:"H7", status:"scripted", proof:"exact namespace, bounded ancestry, live-child authority, Copilot aliases and nested parent ownership" },
      { oracle:"H8", status:"scripted", proof:"hung underlying read remains counted despite consumer expiry; finite explicit renewals" },
      { oracle:"H9", status:"scripted-fixture", proof:"one original effect/receipt fixture; transcript cannot settle it; no durable admission/crash proof" },
      { oracle:"native runtime / cold joins", status:"conditional", proof:"selected live root subsets have separate receipts; complete conformance, cold joins and further native work need their own evidence/finite allowance" },
      { oracle:"combined two-viewer older-history Root/Host disconnect", status:"unresolved", proof:"real close/quarantine caller remains unproved; no transport change" },
    ],
  };
} catch (error) {
  receipt = { status:"failed-diagnostic", sourceHash, completedAt:new Date().toISOString(), error: String(error.message ?? "Qualification failed") };
  process.exitCode = 1;
}
const resultText = JSON.stringify(receipt,null,2)+"\n";
await writeFile(join(artifact,"result.json"), resultText);
await writeFile(join(artifact,"checks.log"), log.join("\n"));
await writeFile(join(artifact,"SHA256SUMS"), `${sha(manifestText)}  manifest.json\n${sha(resultText)}  result.json\n${sha(log.join("\n"))}  checks.log\n`);
console.log(`${receipt.status}: source ${sourceHash}`);
if (receipt.tests) console.log(`${receipt.tests.node} node invariants; ${receipt.tests.browser} browser cases`);
if (receipt.error) console.error(receipt.error);
