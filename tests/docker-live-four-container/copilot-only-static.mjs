#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const files = {
  run: join(directory, "copilot-only-run.sh"),
  driver: join(directory, "copilot-only-driver.mjs"),
  proxy: join(directory, "copilot-only-provider-proxy.mjs"),
  dockerfile: join(directory, "copilot-only-Dockerfile"),
  docs: join(directory, "COPILOT-ONLY.md"),
};
const source = Object.fromEntries(
  await Promise.all(Object.entries(files).map(async ([name, path]) => [name, await readFile(path, "utf8")])),
);

assert.equal((source.driver.match(/\.sessions\.execute\.mutate\(/g) ?? []).length, 1,
  "driver must contain exactly one model-bearing execute mutation");
assert.match(source.driver, /const model = "gpt-6-luna";/);
assert.doesNotMatch(source.driver, /harness:\s*"codex"/);
assert.match(source.driver, /nativeType === "assistant\.message"/);
assert.match(source.driver, /nativeType === "session\.idle"/);
assert.match(source.driver, /sessions\.stop\.mutate\(stopCommand/);
assert.match(source.driver, /sessions\.resume\.mutate\(resumeCommand/);
assert.match(source.driver, /interactions\.list\.query\(\{\s*sessionId,\s*pendingOnly: true,/);
assert.match(source.driver, /interactions\.resolve\.mutate\(\{/);
assert.match(source.driver, /nativeType === "exit_plan_mode\.requested"/);
assert.match(source.driver, /nativeType === "exit_plan_mode\.completed"/);
assert.match(source.driver, /never fabricates or retries that callback/);

assert.match(source.run, /AGENT_MULTIPLEX_COPILOT_ONLY_RUN/);
assert.match(source.run, /I_UNDERSTAND_ONE_GPT_6_LUNA_REQUEST/);
const harnessEnvironmentLines = source.run.split("\n").filter((line) =>
  /--env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=/.test(line)
);
assert.deepEqual(harnessEnvironmentLines.map((line) => line.trim()), [
  "--env AGENT_MULTIPLEX_RUNTIME_NODE_HARNESSES=copilot \\",
]);
assert.match(source.run, /--mount type=bind,src="\$SOURCE_KEY",dst=\/run\/secrets\/codex-lb-api-key,readonly/);
assert.match(source.run, /secret_values_present_in_receipt/);
assert.match(source.run, /identity mismatch/);
assert.match(source.run, /copilot-only-provider-proxy\.mjs/);
assert.match(source.run, /git -C "\$REPO_ROOT" diff --quiet --exit-code HEAD --/);
assert.match(source.run, /--static/);

assert.match(source.proxy, /credential-free HTTP\(S\) URL/);
assert.doesNotMatch(source.proxy, /console\.(?:log|error)/);
assert.match(source.dockerfile, /FROM node:24\.19\.0-bookworm-slim@sha256:/);
assert.match(source.dockerfile, /@github\/copilot-sdk/);
assert.match(source.docs, /exactly one synthetic `gpt-6-luna` prompt/);
assert.match(source.docs, /pending `exitPlan`/);

process.stdout.write(`${JSON.stringify({
  passed: true,
  files: Object.values(files).map((path) => path.slice(directory.length + 1)),
  checks: {
    exactExecuteMutationCount: 1,
    fixedModel: "gpt-6-luna",
    copilotOnlyRuntime: true,
    nativeReplyAndIdleAssertions: true,
    gatewayPendingExitPlanProbe: true,
    stopResumeAssertions: true,
    explicitLiveOptIn: true,
    sourceSecretCleanupFencesPresent: true,
  },
}, null, 2)}\n`);
