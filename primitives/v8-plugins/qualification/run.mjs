import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url), root = fileURLToPath(new URL("..", import.meta.url));
for (const args of [[require.resolve("typescript/bin/tsc"), "--project", "tsconfig.json"], ["--test", "--test-concurrency=1", "--test-timeout=15000", ".build/primitives/v8-plugins/qualification/contracts.test.js"]]) {
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: "inherit", timeout: 60000 });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
