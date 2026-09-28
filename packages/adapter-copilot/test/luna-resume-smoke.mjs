// Disposable real-Copilot BYOK qualification: one model-directed prompt, then
// same-home restart/resume. Run only in a private glibc container with a
// read-only API-key mount; never point at a production session or Copilot home.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RuntimeConnection } from "@github/copilot-sdk";
import { CopilotAgentAdapter } from "../src/adapter.ts";

const model = process.env.COPILOT_TEST_MODEL;
assert.equal(model, "gpt-6-luna", "This bounded run is pinned to the authorized inexpensive model");
const endpoint = new URL(process.env.COPILOT_TEST_BASE_URL ?? "");
assert.ok(["https:", "http:"].includes(endpoint.protocol) && !endpoint.username && !endpoint.password && !endpoint.search && !endpoint.hash);
const key = (await readFile(process.env.COPILOT_TEST_KEY_FILE ?? "", "utf8")).trim();
assert.ok(key.length >= 16, "The read-only provider key file is unavailable");
const home = await mkdtemp(join(tmpdir(), "copilot-luna-resume-"));
const project = join(home, "project");
await mkdir(project, { mode: 0o700 });
const cliPath = createRequire(import.meta.url).resolve(`@github/copilot-${process.platform}-${process.arch}`);
const nativeEnv = { HOME: home, COPILOT_HOME: join(home, "copilot"), COPILOT_AUTO_UPDATE: "false", XDG_CACHE_HOME: join(home, "cache"), PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
  // The slim Node image does not ship CA certificates. Supply a trusted host
  // bundle read-only; never weaken or bypass certificate verification.
  SSL_CERT_FILE: process.env.COPILOT_TEST_CA_FILE ?? "/run/ca-bundle.pem" };
const makeAdapter = () => new CopilotAgentAdapter({
  adapterScopeId: "copilot:disposable-luna-resume",
  clientOptions: { baseDirectory: nativeEnv.COPILOT_HOME, env: nativeEnv, useLoggedInUser: false, logLevel: "none", connection: RuntimeConnection.forStdio({ path: cliPath }) },
  provider: { type: "openai", baseUrl: endpoint.href, wireApi: "responses", transport: "http", apiKey: key },
  defaultModel: model, providerModels: [model],
});
let adapter, session, promptCount = 0, deadline;
let stage = "native-start", sawExactAnswer = false, sawIdle = false;
const eventCounts = Object.create(null);
let nativeErrorCategory = null, nativeErrorSummary = null;
try {
  adapter = makeAdapter();
  const description = await adapter.describe();
  assert.equal(description.available, true, "Native Copilot CLI did not start");
  stage = "fresh-create";
  session = await adapter.spawn({ harness: "copilot", cwd: project, model });
  const vendorSessionId = session.vendorSessionId;
  const marker = `LUNA_${randomBytes(7).toString("hex").toUpperCase()}`;
  let resolveTurn, rejectTurn;
  const turn = new Promise((resolve, reject) => { resolveTurn = resolve; rejectTurn = reject; });
  deadline = setTimeout(() => rejectTurn(new Error("Native turn did not settle within the bounded deadline")), 90_000);
  const unsubscribe = session.subscribe(event => {
    if (event.kind !== "native") return;
    eventCounts[event.nativeType] = (eventCounts[event.nativeType] ?? 0) + 1;
    if (event.nativeType === "assistant.message" && event.payload?.data?.content?.trim() === marker) sawExactAnswer = true;
    if (event.nativeType === "session.idle") sawIdle = true;
    if (event.nativeType === "session.error") {
      const error = JSON.stringify(event.payload?.data ?? {});
      const lower = error.toLowerCase();
      nativeErrorCategory = /model.*(not found|unknown|unsupported|unavailable)|invalid model/.test(lower) ? "MODEL_ROUTE_REJECTED"
        : /unauthorized|forbidden|authentication|api key|401|403/.test(lower) ? "PROVIDER_AUTH_REJECTED" : "NATIVE_ERROR";
      nativeErrorSummary = error.replaceAll(key, "<key>").replaceAll(endpoint.href, "<provider>")
        .replace(/https?:\/\/[^\s\"']+/g, "<url>").replace(/[A-Za-z0-9_-]{43,}/g, "<opaque>").slice(0, 500);
      rejectTurn(new Error("Native session reported an error"));
    }
    if (sawExactAnswer && sawIdle) resolveTurn();
  });
  stage = "one-model-prompt";
  promptCount++;
  const admitted = await session.execute({ harness: "copilot", command: { type: "send", prompt: `Reply with exactly ${marker} and no other text.` } });
  assert.equal(typeof admitted?.messageId, "string", "Native send returned no logical message identity");
  await turn;
  clearTimeout(deadline); deadline = undefined; unsubscribe();
  stage = "history-before-resume";
  const before = await session.readNativeHistory({ harness: "copilot", limit: 100 });
  assert.ok(before.payload.some(item => item?.type === "assistant.message" && item?.data?.content?.trim() === marker), "Native persisted history omitted the exact response");
  const statusAfterPrompt = session.status();
  // A full adapter close simulates the host attachment ending; retain only this
  // disposable Copilot home, then reattach the same vendor session ID.
  await adapter.close(); adapter = undefined; session = undefined;
  stage = "resume-existing";
  adapter = makeAdapter();
  const resumed = await adapter.resume({ harness: "copilot", vendorSessionId, cwd: project, model, continuePendingWork: false });
  session = resumed;
  const evidence = [];
  const unsubscribeResume = resumed.subscribe(event => { if (event.kind === "lifecycle") evidence.push(event.fact); });
  assert.ok(evidence.some(item => item.type === "interactionsHydrated" && item.complete === false), "Resume incorrectly asserted complete ephemeral interaction hydration");
  assert.ok(evidence.some(item => item.type === "childrenHydrated" && item.complete === false), "Resume incorrectly asserted complete child hydration");
  const after = await resumed.readNativeHistory({ harness: "copilot", limit: 100 });
  assert.ok(after.payload.some(item => item?.type === "assistant.message" && item?.data?.content?.trim() === marker), "Native history did not survive resume");
  const tasks = await resumed.readNativeState({ harness: "copilot", view: "tasks" });
  assert.ok(Array.isArray(tasks.payload?.tasks), "Native task registry was not readable after resume");
  unsubscribeResume();
  console.log(JSON.stringify({ result: "passed", model, promptCount, admittedWithMessageId: true,
    exactReplyAndIdleObserved: sawExactAnswer && sawIdle, nativeHistorySurvivedResume: true,
    resumedChildrenAndInteractionsRemainPartial: true, taskRegistryReadable: true,
    statusAfterPrompt, statusAfterResume: resumed.status() }));
} catch (error) {
  // No endpoint, token, prompt, native session ID or raw native error in output.
  const text = String(error instanceof Error ? error.message : error).toLowerCase();
  const category = /model.*(not found|unknown|unsupported|unavailable)|invalid model/.test(text) ? "MODEL_ROUTE_REJECTED"
    : /unauthorized|forbidden|authentication|api key|401|403/.test(text) ? "PROVIDER_AUTH_REJECTED"
    : /timeout|deadline|settle/.test(text) ? "NATIVE_TURN_TIMEOUT" : "NATIVE_TEST_FAILED";
  console.error(JSON.stringify({ result: "failed", stage, category, nativeErrorCategory, promptCount,
    sawExactAnswer, sawIdle, eventCounts, adapterStatus: session?.status?.() ?? null, nativeErrorSummary }));
  process.exitCode = 1;
} finally {
  if (deadline) clearTimeout(deadline);
  await session?.stop().catch(() => undefined);
  await adapter?.close().catch(() => undefined);
  await rm(home, { recursive: true, force: true });
}
