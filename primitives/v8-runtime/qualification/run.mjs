import { spawnSync } from "node:child_process";
const built = spawnSync(process.execPath, ["../../node_modules/typescript/bin/tsc", "--project", "tsconfig.json"], { cwd: new URL("../", import.meta.url), stdio: "inherit", timeout: 60000 });
if (built.status !== 0) process.exit(built.status ?? 1);
const checked = spawnSync(process.execPath, ["--test", "--test-timeout=20000", ".build/primitives/v8-runtime/qualification/runtime.test.js"], { cwd: new URL("../", import.meta.url), stdio: "inherit", timeout: 90000 });
process.exit(checked.status ?? 1);
