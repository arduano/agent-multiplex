import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";

// Imported only by the integration owner after a fresh finite allowance.
// No automatic entry point, fallback model, existing home, getEvents(), replay or global process scan.
const ROOT_FINAL = "V8_COPILOT_ROOT_OK";
const TERMINAL_START = "V8_COPILOT_TERMINAL_OK";
const TERMINAL_END = "V8_COPILOT_TERMINAL_DONE";
const CHILD_NAME = "v8-proof-child";
const CHILD_FINAL = "V8_COPILOT_CHILD_OK";
const PARENT_FINAL = "V8_COPILOT_PARENT_OK";
const COMMAND = `printf '${TERMINAL_START}\\n'; sleep 1; printf '${TERMINAL_END}\\n'`;
class LaneError extends Error { constructor(code) { super(code); this.code = code; } }
const requireThat = (condition, code) => { if (!condition) throw new LaneError(code); };
const rootEvent = event => !event.agentId && !event.data?.agentId && !event.data?.parentToolCallId;
const textOf = row => row.body.kind === "unavailable" ? "" : row.body.text;

async function bounded(promise, milliseconds, code) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new LaneError(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function packageRoot(entry, name) {
  let directory = dirname(entry);
  for (let index = 0; index < 5; index++, directory = dirname(directory)) {
    try { const metadata = JSON.parse(await readFile(join(directory, "package.json"), "utf8")); if (metadata.name === name) return { directory, metadata }; }
    catch { /* Only dependency metadata is examined; no runtime or user state. */ }
  }
  throw new LaneError("PinnedDependencyMetadataMissing");
}
const GLIBC_IMAGE = "node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df";
const DOCKER = "/run/current-system/sw/bin/docker";
async function docker(args) {
  return new Promise((resolveCall, reject) => execFile(DOCKER,args,{encoding:"utf8",timeout:8000,maxBuffer:65536},(error,stdout)=>error?reject(new LaneError("OwnedContainerCommandFailed")):resolveCall(stdout)));
}
async function launcher(cli, ctx) {
  await docker(["image","inspect",GLIBC_IMAGE,"--format","{{.Id}}"]);
  requireThat(typeof process.execve === "function", "NativeExecveUnavailable");
  const nativeHome=ctx.nativeHome,containerName=`multiplex-v8-live-${randomUUID()}`;
  const filename=join(nativeHome,"owned-cli-launcher.js"),ownerFile=join(nativeHome,"owned-cli-process.json");
  const args=[DOCKER,"run","--rm","--interactive","--name",containerName,"--network","host","--read-only","--cap-drop","ALL","--security-opt","no-new-privileges","--pids-limit","128","--memory","2g","--user",`${process.getuid()}:${process.getgid()}`,"--tmpfs","/tmp:rw,exec,nosuid,nodev,mode=1777",
    "--mount",`type=bind,src=${dirname(cli)},dst=${dirname(cli)},readonly`,"--mount",`type=bind,src=${nativeHome},dst=${nativeHome}`,"--mount",`type=bind,src=${ctx.workspace},dst=${ctx.workspace}`,"--workdir",ctx.workspace];
  for(const [key,value]of Object.entries({HOME:nativeHome,COPILOT_HOME:nativeHome,PATH:"/usr/local/bin:/usr/bin:/bin",SHELL:"/bin/bash",LANG:"C.UTF-8",TMPDIR:"/tmp",XDG_CONFIG_HOME:join(nativeHome,"xdg-config"),XDG_CACHE_HOME:join(nativeHome,"xdg-cache"),XDG_DATA_HOME:join(nativeHome,"xdg-data")}))args.push("--env",`${key}=${value}`);
  args.push(GLIBC_IMAGE,cli);
  const source=`import {readFileSync,writeFileSync} from 'node:fs';\n`+
    `const stat=readFileSync('/proc/self/stat','utf8');const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];\n`+
    `writeFileSync(${JSON.stringify(ownerFile)},JSON.stringify({pid:process.pid,start}),{mode:0o600});\n`+
    `process.execve(${JSON.stringify(DOCKER)},[...${JSON.stringify(args)},...process.argv.slice(2)],process.env);\n`;
  await writeFile(filename,source,{mode:0o700});
  return {filename,ownerFile,containerName,image:GLIBC_IMAGE,mode:"owned-pinned-glibc-container"};
}
async function containerExists(name) {
  try { await docker(["container","inspect",name,"--format","{{.State.Running}}"]); return true; } catch { return false; }
}
async function ownedProcessExited(ownerFile) {
  let owner;
  try { owner = JSON.parse(await readFile(ownerFile, "utf8")); } catch { return null; }
  requireThat(Number.isSafeInteger(owner.pid) && owner.pid > 0 && /^\d+$/.test(owner.start), "InvalidOwnedProcessIdentity");
  const until = Date.now() + 3000;
  do {
    const stat = await readFile(`/proc/${owner.pid}/stat`, "utf8").catch(() => null);
    if (!stat || stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== owner.start) return true;
    await new Promise(resolveWait => setTimeout(resolveWait, 50));
  } while (Date.now() < until);
  return false;
}

export async function runCopilotLive(ctx) {
  requireThat(typeof ctx.model === "string" && ctx.model.length > 0, "UnallowedModel");
  for (const directory of [ctx.toolRoot, ctx.workspace, ctx.nativeHome]) requireThat(typeof directory === "string" && isAbsolute(directory), "DisposableAbsoluteRootRequired");
  requireThat(resolve(ctx.nativeHome) !== resolve(ctx.toolRoot) && resolve(ctx.workspace) !== resolve(ctx.toolRoot), "DisposableRootOverlapsTools");
  requireThat(typeof ctx.endpoint === "string" && typeof ctx.key === "string" && ctx.key.length > 0, "PrivateProviderConfigurationRequired");
  const endpoint = new URL(ctx.endpoint);
  requireThat(endpoint.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname), "OwnerLoopbackProviderGuardRequired");
  const result = { harness: "copilot", passed: false, status: "unqualified", proofs: [], limitations: [],
    counts: { rootSends: 0, admittedChildren: 0, childStarts: 0, childTurns: 0, nativeBodyReads: 0, nativeMetadataReads: 0, events: 0 },
    child: { status: "unqualified", reason: "NotAttempted" }, cleanup: { sessionDisconnected: false, stopAcknowledged: false, ownedProcessExited: null, postStopRpcRejected: false } };
  let client, session, launch, phase = "starting", fatal = null, accepting = true;
  let rootIdle = 0, observationInstalled = false, createPending = false, duringCreate = 0;
  let activeFeed = null, firstLease = null, secondLease = null, firstUnsubscribe = null, secondUnsubscribe = null;
  let childGate = false, childToolUsed = false, expectedTaskArgument = null;
  const eventIds = new Set(), notificationIds = new Set(), finals = new Map(), toolResults = new Map(), observedChildren = new Set();
  const eventKinds = new Map(), childModels = new Set(), actualChildModels = new Set(), waiters = new Set();
  const notify = () => { for (const listener of [...waiters]) listener(); };
  const fail = code => { fatal ??= code; notify(); };
  const active = () => requireThat(accepting && !fatal, fatal ?? "LiveOwnerRetired");
  const safeRecord = (name, value) => ctx.record(name, value);
  function safeFailure(error) {
    let message = typeof error?.message === "string" ? error.message : "NonErrorFailure";
    for (const value of [ctx.key, ctx.endpoint, ctx.nativeHome, ctx.workspace, ctx.toolRoot]) if (value) message = message.split(value).join("[redacted]");
    message = message.replace(/https?:\/\/[^\s<>"']+/g, "[redacted-url]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]");
    const code = typeof error?.code === "number" ? error.code : typeof error?.code === "string" ? error.code.slice(0, 100) : null;
    return { name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error", code, message: message.slice(0, 1200) };
  }
  function waitUntil(predicate, milliseconds, code) {
    return bounded(new Promise((resolveWait, reject) => {
      const check = () => { if (fatal) { waiters.delete(check); reject(new LaneError(fatal)); } else if (predicate()) { waiters.delete(check); resolveWait(); } };
      waiters.add(check); check();
    }), milliseconds, code);
  }
  try {
    const work = async () => {
      const fromApp = createRequire(join(ctx.toolRoot, "package.json"));
      const sdk = await packageRoot(fromApp.resolve("@github/copilot-sdk"), "@github/copilot-sdk");
      const cliPackage = await packageRoot(fromApp.resolve("@github/copilot/package.json"), "@github/copilot");
      requireThat(sdk.metadata.version === "1.0.19" && sdk.metadata.copilotCliVersion === "1.0.95" && cliPackage.metadata.version === "1.0.95", "PinnedDependencyVersionMismatch");
      requireThat(process.platform === "linux" && process.arch === "x64", "UnqualifiedNativePlatform");
      const cli = fromApp.resolve("@github/copilot-linux-x64");
      const platform = await packageRoot(cli, "@github/copilot-linux-x64");
      requireThat(platform.metadata.version === "1.0.95", "PinnedNativeVersionMismatch");
      await mkdir(ctx.nativeHome, { recursive: true, mode: 0o700 });
      await mkdir(ctx.workspace, { recursive: true, mode: 0o700 });
      for (const name of ["tmp", "xdg-config", "xdg-cache", "xdg-data"]) await mkdir(join(ctx.nativeHome, name), { recursive: true, mode: 0o700 });
      launch = await launcher(cli, ctx);
      safeRecord("copilot-dependencies", { sdk: "1.0.19", cli: "1.0.95", launcher: launch.mode, image: launch.image });
      const { CopilotClient, RuntimeConnection } = await import(pathToFileURL(join(sdk.directory, "dist/index.js")).href);
      const sessionId = randomUUID();
      const scope = { kind: "copilot", agentId: null, origin: { connection: "owned-live", principal: "allowance-owner", host: "disposable-host", nativeSession: sessionId, attachment: "first-capture" } };
      const hub = new ctx.core.HistoryHub();
      const codec = ctx.core.createCopilotCodec({ origin: scope.origin, capture: hub, knownStart: true });
      const workspace = new ctx.core.HistoryWorkspace({ connection: scope.origin.connection, principal: scope.origin.principal });
      const retained = workspace.session(scope); retained.setPinned(true); retained.setDraft("Retained live qualification draft");
      firstLease = retained.mount("left"); secondLease = retained.mount("right");
      let firstPublications = 0, secondPublications = 0;
      firstUnsubscribe = firstLease.view.subscribe(() => { firstPublications++; });
      secondUnsubscribe = secondLease.view.subscribe(() => { secondPublications++; });
      let feedError = null;
      function connectFeed(cursor) {
        const feed = hub.watch(scope, cursor); activeFeed = feed;
        void (async () => { for await (const frame of feed) { if (activeFeed !== feed) return; retained.client.apply(frame); notify(); } })().catch(() => { feedError = true; fail("ReusableClientFeedRejected"); });
        return feed;
      }
      connectFeed();
      const onEvent = event => {
        if (!accepting) return;
        if (!observationInstalled) { fail("CaptureNotInstalled"); return; }
        try {
          if (!notificationIds.has(event.id)) {
            requireThat(notificationIds.size < 2048, "LiveNotificationCapacity");
            // The integration owner's record callback owns recursive private-field/URL scrubbing.
            safeRecord("copilot-notification", event); notificationIds.add(event.id);
          }
          if (eventIds.has(event.id)) { codec.observe(event); return; }
          requireThat(eventIds.size < 2048, "LiveEventCapacity");
          codec.observe(event); eventIds.add(event.id); result.counts.events++;
          eventKinds.set(event.type, (eventKinds.get(event.type) ?? 0) + 1);
          if (createPending) duringCreate++;
          if (event.type === "assistant.message" && rootEvent(event)) finals.set(event.data.originatingMessageId, event.data.content);
          if (event.type === "session.idle" && rootEvent(event)) rootIdle++;
          if (event.type === "tool.execution_complete") toolResults.set(event.data.toolCallId, event.data);
          if (event.type === "subagent.started") {
            result.counts.childStarts++;
            const actualAgent = event.agentId ?? event.data.agentId;
            if (typeof actualAgent === "string" && actualAgent.length) observedChildren.add(actualAgent);
            if (!childGate || result.counts.admittedChildren !== 1 || result.counts.childStarts > 1 || event.data.agentName !== CHILD_NAME) fail("UnexpectedNativeChild");
          }
          if (event.type === "assistant.turn_start" && !rootEvent(event)) {
            result.counts.childTurns++; if (result.counts.childTurns > 1) fail("NativeChildTurnAllowanceExceeded");
          }
          if (event.type.startsWith("subagent.") && typeof event.data.model === "string") {
            childModels.add(event.data.model); if (event.data.model !== ctx.model) fail("UnexpectedChildModel");
          }
          const actualChildModel = event.type === "subagent.completed" ? event.data.firstDispatchedModel
            : event.type === "assistant.usage" && !rootEvent(event) ? event.data.model : undefined;
          if (typeof actualChildModel === "string") { actualChildModels.add(actualChildModel); if (actualChildModel !== ctx.model) fail("UnexpectedActualChildModel"); }
          if (event.type === "session.error") fail("NativeSessionError");
        } catch (error) { fail(error instanceof LaneError ? error.code : "NativeCaptureRejected"); }
        notify();
      };
      const shellPolicy = request => {
        if (!accepting) return { kind: "no-result" };
        const cwd = request.resolvedWorkingDirectory;
        const planned = request.kind === "shell" && request.fullCommandText?.trim() === COMMAND && !request.hasWriteFileRedirection &&
          !request.requestSandboxBypass && !request.managedApprovalRequired && Array.isArray(request.possibleUrls) && request.possibleUrls.length === 0 &&
          Array.isArray(request.possiblePaths) && request.possiblePaths.length === 0 &&
          (cwd === undefined || typeof cwd === "string" && resolve(cwd) === resolve(ctx.workspace));
        if (planned) { safeRecord("copilot-planned-shell-policy", { approvedOnce: true, managedPolicyBypassed: false }); return { kind: "approve-once" }; }
        safeRecord("copilot-confirmation-blocked", { blocked: true, managed: request.managedApprovalRequired === true, kind: ["shell", "read", "write", "mcp", "url"].includes(request.kind) ? request.kind : "other" });
        fail("NativeConfirmationRequiresOwner"); return { kind: "no-result" };
      };
      const hooks = {
        onPreToolUse(input) {
          if (input.toolName !== "task") return;
          const arguments_ = input.toolArgs;
          if (!accepting || !childGate || childToolUsed || !expectedTaskArgument || !arguments_ || arguments_[expectedTaskArgument] !== CHILD_NAME) {
            fail("UnallowedChildDispatch"); return { permissionDecision: "deny", permissionDecisionReason: "Finite qualification permits only its one named child dispatch." };
          }
          try { ctx.allowance.admit("copilot-child"); } catch { fail("ChildAllowanceRejected"); return { permissionDecision: "deny", permissionDecisionReason: "Finite child allowance unavailable." }; }
          childToolUsed = true; result.counts.admittedChildren++; return;
        },
        onSubagentStart(input) { if (!childToolUsed || input.agentName !== CHILD_NAME) fail("UnexpectedSubagentStartHook"); },
      };
      const env = { PATH: process.env.PATH ?? "/run/current-system/sw/bin", LANG: "C.UTF-8", HOME: ctx.nativeHome,
        SHELL: "/run/current-system/sw/bin/bash", COPILOT_HOME: ctx.nativeHome, TMPDIR: join(ctx.nativeHome, "tmp"),
        XDG_CONFIG_HOME: join(ctx.nativeHome, "xdg-config"), XDG_CACHE_HOME: join(ctx.nativeHome, "xdg-cache"), XDG_DATA_HOME: join(ctx.nativeHome, "xdg-data"), NODE_NO_WARNINGS: "1" };
      active();
      client = new CopilotClient({ mode: "copilot-cli", connection: RuntimeConnection.forStdio({ path: launch.filename, env }),
        workingDirectory: ctx.workspace, baseDirectory: ctx.nativeHome, useLoggedInUser: false, logLevel: "none" });
      observationInstalled = true; createPending = true;
      ctx.progress("Copilot: creating one isolated pinned SDK session with capture already installed.");
      session = await bounded(client.createSession({ sessionId, model: ctx.model, allowedModels: [ctx.model],
        provider: { type: "openai", wireApi: "responses", transport: "http", baseUrl: ctx.endpoint, apiKey: ctx.key, modelId: ctx.model, wireModel: ctx.model },
        workingDirectory: ctx.workspace, configDirectory: ctx.nativeHome, streaming: true, includeSubAgentStreamingEvents: true,
        onEvent, onPermissionRequest: shellPolicy, hooks,
        customAgentsLocalOnly: true,
        customAgents: [{ name: CHILD_NAME, displayName: "V8 finite child", description: "One exact response for the finite V8 allowance", model: ctx.model,
          prompt: `Reply exactly ${CHILD_FINAL}. Do not use any tool, spawn another agent, access files or networks, or continue after the reply.` }],
      }), 30_000, "NativeCreateDeadline");
      createPending = false; active();
      result.counts.nativeMetadataReads++;
      const selected = await bounded(session.rpc.model.getCurrent(), 10_000, "NativeModelMetadataDeadline");
      requireThat(selected.modelId === ctx.model, "SelectedModelNotExact");
      result.proofs.push("capture installed through createSession.onEvent before first native work", "exact pinned SDK/CLI and explicitly selected model");
      safeRecord("copilot-capture-installation", { beforeCreateDispatch: true, eventsDuringCreate: duringCreate, bodyReads: 0 });

      let childReady = false;
      async function probeChild() {
        if(ctx.skipChild){result.child={status:"unqualified",reason:"NoChildTurnAllocatedInThisPass"};return;}
        phase = "child-probe";
        let configured, task;
        try {
          requireThat(typeof session.rpc.agent?.list === "function" && typeof session.rpc.tools?.initializeAndValidate === "function" &&
            typeof session.rpc.tools?.getCurrentMetadata === "function", "OptionalChildMetadataApiUnavailable");
          result.counts.nativeMetadataReads++;
          const agents = await bounded(session.rpc.agent.list(), 8000, "NativeAgentMetadataDeadline");
          result.counts.nativeMetadataReads++;
          await bounded(session.rpc.tools.initializeAndValidate(), 8000, "NativeToolInitializationDeadline");
          result.counts.nativeMetadataReads++;
          const tools = await bounded(session.rpc.tools.getCurrentMetadata(), 8000, "NativeToolMetadataDeadline");
          configured = agents.agents?.find(agent => agent.id === CHILD_NAME || agent.name === CHILD_NAME);
          task = tools.tools?.find(tool => tool.name === "task");
        } catch (error) {
          if (fatal) throw new LaneError(fatal);
          result.child = { status: "unqualified", reason: "OptionalChildMetadataUnavailable" };
          safeRecord("copilot-child-metadata-unqualified", { noChildDispatchAttempted: true, failure: safeFailure(error) });
        }
        const properties = task?.input_schema?.properties;
        const exactModel = configured?.model === ctx.model || Array.isArray(configured?.models) && configured.models.length === 1 && configured.models[0] === ctx.model;
        childReady = exactModel && !!properties && Object.prototype.hasOwnProperty.call(properties, "agent_type");
        if (childReady) expectedTaskArgument = "agent_type";
        safeRecord("copilot-child-probe", { exactAgentRegistered: !!configured, exactAgentModel: exactModel, taskToolAvailable: !!task, agentTypeArgumentPresent: !!properties && Object.prototype.hasOwnProperty.call(properties, "agent_type") });
      }
      const combined = ctx.combinedCopilot === true;
      if (combined) {
        await probeChild(); childGate = childReady; phase = childReady ? "combined-root-and-child" : "root";
        safeRecord("copilot-combined-turn-plan", { combined: true, plannedRootSends: 1, childMetadataProved: childReady === true });
      }
      const idleBefore = rootIdle;
      const toolStartsBefore = eventKinds.get("tool.execution_start") ?? 0;
      retained.recordOperation("root-original", { action: "send", marker: ROOT_FINAL });
      active();
      ctx.allowance.admit("copilot-root"); result.counts.rootSends++;
      const childInstruction = combined && childReady
        ? `After the shell succeeds, invoke exactly one native task for custom agent ${CHILD_NAME}, using agent_type ${CHILD_NAME}; its model is ${ctx.model}. Ask it to reply exactly ${CHILD_FINAL} without tools or further delegation. Wait for it to finish. Never retry or launch another child. After both shell and child succeed, reply exactly ${ROOT_FINAL}.`
        : `Do not delegate. After command success, reply exactly ${ROOT_FINAL}.`;
      const nativeMessageId = await bounded(session.send({ prompt: `This is one finite disposable qualification. Run the normal built-in shell once with exactly this command: ${COMMAND}\nDo not inspect or modify files or access network or MCP services. Use only this shell command and the one named task if explicitly requested below. ${childInstruction}` }), 20_000, "NativeSendAdmissionDeadline");
      requireThat(typeof nativeMessageId === "string" && nativeMessageId.length > 0, "MissingOriginalSendId");
      retained.observeOperation("root-original", { admitted: true, nativeMessageId });
      // Detaching viewers must not own the native session or the pinned Host capture.
      await waitUntil(() => (eventKinds.get("tool.execution_start") ?? 0) > toolStartsBefore, 45_000, "NativeToolStartDeadline");
      const detachedAt = result.counts.events;
      firstUnsubscribe(); secondUnsubscribe(); firstLease.release(); secondLease.release();
      firstUnsubscribe = null; secondUnsubscribe = null; firstLease = null; secondLease = null;
      requireThat(retained.mountedReferences === 0 && retained.backgroundReferenceHeld, "PinnedBackgroundReferenceMissing");
      workspace.setConnected(false);
      const cursor = retained.client.current && { generation: retained.client.current.generation, revision: retained.client.current.revision };
      const stoppedFeed = activeFeed; activeFeed = null; await stoppedFeed.return();
      await waitUntil(() => rootIdle > idleBefore && finals.get(nativeMessageId) === ROOT_FINAL, 65_000, "NativeRootCompletionDeadline");
      requireThat(result.counts.events > detachedAt, "NoBackgroundCaptureAfterDetach");
      const rootRows = hub.snapshot(scope).rows;
      requireThat(rootRows.some(row => row.kind === "assistant" && textOf(row) === ROOT_FINAL && row.body.kind === "complete"), "NativeFinalNotCaptured");
      requireThat(rootRows.some(row => row.kind === "tool" && row.body.kind === "complete" && textOf(row).includes(TERMINAL_START) && textOf(row).includes(TERMINAL_END)), "NativeTerminalOutputNotCaptured");
      requireThat([...toolResults.values()].some(data => data.success === true), "NativeToolNotSuccessful");
      requireThat(result.counts.nativeBodyReads === 0, "HealthyPathReadNativeHistory");
      retained.observeOperation("root-original", { admitted: true, nativeCompleted: true, nativeMessageId }, true);
      workspace.setConnected(true); connectFeed(cursor ?? undefined);
      firstLease = retained.mount("left"); secondLease = retained.mount("right");
      await waitUntil(() => firstLease.view.getSnapshot().rows.some(row => textOf(row) === ROOT_FINAL), 5000, "ClientReconnectDeadline");
      requireThat(JSON.stringify(firstLease.view.getSnapshot().rows) === JSON.stringify(secondLease.view.getSnapshot().rows), "TwoViewsDiverged");
      requireThat(retained.pinned && retained.draft === "Retained live qualification draft" && retained.operations[0].settled && retained.operations[0].observation.nativeMessageId === nativeMessageId, "RetainedWorkspaceStateLost");
      requireThat(!feedError && firstPublications > 0 && secondPublications > 0, "TwoNamedViewsNotObserved");
      result.proofs.push("original native SDK Send admission ID retained and correlated to exact final without replay", "native shell full result and full assistant final captured with zero healthy native-body reads",
        "both UI leases and feed detached while native capture completed", "pinned workspace draft and operation retained; two named views converged on Host reconnect");
      safeRecord("copilot-healthy-stream", { healthyBodyReads: 0, exactOriginalCorrelation: true, terminalMarkersCaptured: true,
        twoNamedViewsConverged: true, completedWithNoMountedViewer: true, pinnedStateRetained: true });

      if (!combined) await probeChild();
      if (childReady) {
        childGate = true; phase = "child";
        if (!combined) {
          const beforeChild = rootIdle;
          active();
          ctx.allowance.admit("copilot-root"); result.counts.rootSends++;
          const childParentMessage = await bounded(session.send({ prompt: `Invoke exactly one native task for custom agent ${CHILD_NAME}, using agent_type ${CHILD_NAME}; its model is ${ctx.model}. Ask it to reply exactly ${CHILD_FINAL} without any tools or further delegation. Do not use any other tool or inspect files/network. After the child finishes, reply exactly ${PARENT_FINAL}. Do not retry or launch a second child.` }), 20_000, "ChildParentAdmissionDeadline");
          await waitUntil(() => rootIdle > beforeChild && finals.get(childParentMessage) === PARENT_FINAL, 55_000, "NativeChildCompletionDeadline");
        }
        requireThat(result.counts.admittedChildren === 1 && result.counts.childStarts === 1 && result.counts.childTurns === 1 && observedChildren.size === 1, "ChildCardinalityNotExact");
        requireThat(childModels.has(ctx.model) && actualChildModels.has(ctx.model), "ActualChildModelUnobserved");
        const childAgent = [...observedChildren][0];
        const childScope = { ...scope, agentId: childAgent };
        const childRows = hub.snapshot(childScope).rows;
        requireThat(childRows.some(row => row.kind === "assistant" && textOf(row) === CHILD_FINAL && row.body.kind === "complete"), "NativeChildBodyNotCaptured");
        requireThat(!hub.snapshot(scope).rows.some(row => row.kind === "assistant" && textOf(row) === CHILD_FINAL), "ChildBodyContaminatedRoot");
        result.child = { status: "qualified", reason: "OneExactCustomAgentCaptured" };
        result.proofs.push("one positively identified native custom child captured in its own scope with exact selected model");
      } else {
        if (result.child.reason === "NotAttempted") result.child = { status: "unqualified", reason: "ExactCustomAgentOrTaskSchemaUnavailable" };
        result.limitations.push(ctx.skipChild?"No child model turn allocated: the remaining pass budget qualifies only the real root path.":"No child model send attempted because native metadata did not prove the exact custom-agent/task contract.");
      }
      childGate = false;
      // Explicit read-only native audit begins only after all healthy streaming assertions.
      phase = "history-audit";
      if (typeof session.rpc.eventLog?.read === "function") {
        result.counts.nativeBodyReads++;
        const page = await bounded(session.rpc.eventLog.read({ direction: "backward", max: 64, includeEphemeral: false, waitMs: 0 }), 10_000, "NativeAuditReadDeadline");
        requireThat(Array.isArray(page.events) && page.events.length <= 64, "NativeAuditPageOutOfBounds");
        const matchingIds = page.events.filter(event => eventIds.has(event.id)).length;
        safeRecord("copilot-native-history-audit", { nativeBodyReads: 1, returnedEvents: page.events.length, sharedObservedEventIds: matchingIds,
          moreHistory: page.hasMore === true, cursorAccepted: page.cursorStatus === "ok", appliedToLiveCodec: false });
        requireThat(matchingIds > 0, "NativeAuditIdentityDomainUnconfirmed");
        result.proofs.push("one bounded post-stream native audit matched actual live event IDs without importing its snapshot");
      } else result.limitations.push("Pinned runtime did not expose bounded eventLog.read; no getEvents fallback was attempted.");
      result.limitations.push("Native shell result is proved; distinct shell-output delta support is reported from observed event counts.",
        "This is finite SDK/Host/client integration, not the unresolved combined two-viewer older-history disconnect case or a real browser transport proof.");
      safeRecord("copilot-event-shapes", { assistantDeltas: eventKinds.get("assistant.message_delta") ?? 0,
        toolShellOutput: eventKinds.get("tool.shell_output") ?? 0, deprecatedToolPartials: eventKinds.get("tool.execution_partial_result") ?? 0,
        childStarts: result.counts.childStarts, codecRejected: fatal !== null });
      active(); result.passed = true; result.status = result.child.status === "qualified" ? "qualified" : "partial";
    };
    await bounded(work(), 150_000, "CopilotOverallDeadline");
  } catch (error) {
    accepting = false; fail(error instanceof LaneError ? error.code : "CopilotLiveApiFailure");
    result.status = (fatal === "NativeConfirmationRequiresOwner") ? "blocked" : "failed";
    result.reason = error instanceof LaneError ? error.code : "CopilotLiveApiFailure";
    safeRecord("copilot-live-exception", { phase, reason: result.reason, failure: safeFailure(error), confirmationBlocked: fatal === "NativeConfirmationRequiresOwner", noModelSendRetried: true });
  } finally {
    accepting = false; childGate = false; firstUnsubscribe?.(); secondUnsubscribe?.(); firstLease?.release(); secondLease?.release();
    if (activeFeed) { const feed = activeFeed; activeFeed = null; await feed.return().catch(() => {}); }
    if (session) {
      try { await bounded(session.disconnect(), 8000, "SessionDisconnectDeadline"); result.cleanup.sessionDisconnected = true; }
      catch { result.limitations.push("Own session disconnect was not acknowledged before cleanup deadline."); }
    }
    if (client) {
      try {
        const errors = await bounded(client.stop(), 15_000, "ClientStopDeadline");
        result.cleanup.stopAcknowledged = errors.length === 0;
        if (errors.length) result.limitations.push("SDK stop returned cleanup errors; raw native diagnostics were not recorded.");
      } catch {
        result.limitations.push("SDK stop deadline/failure required supported forceStop of this owned client only.");
        try { await bounded(client.forceStop(), 5000, "ClientForceStopDeadline"); } catch { /* Report exact owned PID below. */ }
      }
      try { await bounded(client.getStatus(), 1000, "PostStopStatusDeadline"); }
      catch { result.cleanup.postStopRpcRejected = true; }
    }
    if (launch) {
      result.cleanup.ownedProcessExited = await ownedProcessExited(launch.ownerFile).catch(() => false);
      result.cleanup.containerRemoved = !(await containerExists(launch.containerName));
      if (!result.cleanup.containerRemoved) {
        result.passed=false;result.status="failed";result.limitations.push("Own container needed explicit final cleanup after SDK release; native release is unqualified.");
        await docker(["container","stop","--time","2",launch.containerName]).catch(()=>{});
        result.cleanup.containerRemoved=!(await containerExists(launch.containerName));
      }
    }
    if (client && (!result.cleanup.stopAcknowledged || result.cleanup.ownedProcessExited !== true || !result.cleanup.postStopRpcRejected)) {
      result.passed = false; if (result.status !== "blocked") result.status = "failed";
    }
    result.limitations.push("Cleanup proof covers supported session disconnect, SDK-owned runtime stop, exact owned SDK process exit, own-container removal and rejected post-stop RPC; no unrelated process/session was inspected.");
    safeRecord("copilot-owned-cleanup", result.cleanup);
    waiters.clear(); ctx.progress("Copilot: finite owned live lane finished; only its own SDK session/runtime cleanup was requested.");
  }
  return result;
}
