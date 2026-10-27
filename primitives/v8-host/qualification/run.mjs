import { spawnSync } from "node:child_process";
const cwd = new URL("../", import.meta.url);
const build = spawnSync(process.execPath, ["../../node_modules/typescript/bin/tsc", "--project", "tsconfig.json"], { cwd, stdio: "inherit", timeout: 60000 });
if (build.status !== 0) process.exit(build.status ?? 1);
const run = spawnSync(process.execPath, ["--test", "--test-concurrency=1", "--test-timeout=60000", ".build/primitives/v8-host/qualification/host.test.js"], { cwd, stdio: "inherit", timeout: 120000 });
process.exit(run.status ?? 1);
