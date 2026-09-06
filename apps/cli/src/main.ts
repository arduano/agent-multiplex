#!/usr/bin/env node

import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { extname } from "node:path";

import {
  archiveRequest,
  createAccessClient,
  launchRequest,
  imageMessage,
  imageTarget,
  uploadImage,
  resumeCommand,
  sessionCommand,
  stopCommand as createStopCommand,
  watchAccess,
  type AccessClient,
} from "@arduano/agent-multiplex-client";
import {
  accessContract,
  harnessCommandSchema,
  harnessSchema,
  harnessSpawnOptionsSchema,
  interactionIdSchema,
  jsonObjectSchema,
  jsonValueSchema,
  metadataKeySchema,
  metadataPatchSchema,
  metadataValuesSchema,
  newOperationId,
  sessionStateSchema,
  sessionIdSchema,
  runtimeNodeIdSchema,
  type ArchiveRecord,
  type AccessStreamItem,
  type CommandRecord,
  type ControlNodeDescriptor,
  type Harness,
  type HarnessCommand,
  type InteractionRecord,
  type ImageMediaType,
  type JsonObject,
  type JsonValue,
  type LaunchProfileDescriptor,
  type LaunchProfileIdentity,
  type LaunchRecord,
  type MetadataSnapshot,
  type NativeHistoryResult,
  type SessionRecord,
  type RuntimeNodeDescriptor,
  type SourceDiagnostic,
} from "@arduano/agent-multiplex-protocol";

const DEFAULT_HTTP_URL = "http://127.0.0.1:4317/trpc";
const VERSION = "0.2.2";

interface GlobalOptions {
  readonly httpUrl: string;
  readonly wsUrl: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly authToken: string | undefined;
  readonly json: boolean;
  readonly help: boolean;
  readonly version: boolean;
  readonly argv: readonly string[];
}

interface ParsedOptions {
  readonly positionals: readonly string[];
  readonly options: ReadonlyMap<string, readonly string[]>;
  readonly flags: ReadonlySet<string>;
}

interface CommandContext {
  readonly client: AccessClient;
  readonly json: boolean;
}

async function main(): Promise<void> {
  try {
    const global = parseGlobalOptions(process.argv.slice(2));
    if (global.version) {
      console.log(VERSION);
      return;
    }
    if (global.help || global.argv.length === 0 || global.argv[0] === "help") {
      printHelp(global.argv[0] === "help" ? global.argv[1] : undefined);
      return;
    }

    const handle = createAccessClient({
      httpUrl: global.httpUrl,
      wsUrl: global.wsUrl,
      ...(global.authToken
        ? { bearerToken: global.authToken }
        : Object.keys(global.headers).length > 0
          ? { headers: () => ({ ...global.headers }) }
          : {}),
    });
    try {
      await dispatch(global.argv[0] ?? "", global.argv.slice(1), {
        client: handle.client,
        json: global.json,
      });
    } finally {
      handle.close();
    }
  } catch (error) {
    console.error(`agent-multiplex: ${errorMessage(error)}`);
    if (process.env.AGENT_MULTIPLEX_DEBUG === "1" && error instanceof Error) {
      console.error(error.stack);
    }
    process.exitCode = 1;
  }
}

async function dispatch(
  command: string,
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  switch (command) {
    case "sources":
      await sourcesCommand(argv, context);
      return;
    case "control-nodes":
      await controlNodesCommand(argv, context);
      return;
    case "runtime-nodes":
      await runtimeNodesCommand(argv, context);
      return;
    case "sessions":
      await sessionsCommand(argv, context);
      return;
    case "spawn":
      await spawnSessionCommand(argv, context);
      return;
    case "resume":
      await resumeSessionCommand(argv, context);
      return;
    case "send":
      await promptCommand("send", argv, context);
      return;
    case "steer":
      await promptCommand("steer", argv, context);
      return;
    case "interrupt":
      await interruptCommand(argv, context);
      return;
    case "stop":
      await stopSessionCommand(argv, context);
      return;
    case "archive":
      await archiveSessionCommand(argv, context);
      return;
    case "model":
      await setModelCommand(argv, context);
      return;
    case "mode":
      await setModeCommand(argv, context);
      return;
    case "effort":
      await setEffortCommand(argv, context);
      return;
    case "turn-settings":
      await updateTurnSettingsCommand(argv, context);
      return;
    case "terminals":
      await terminalsCommand(argv, context);
      return;
    case "metadata":
      await metadataCommand(argv, context);
      return;
    case "history":
      await historyCommand(argv, context);
      return;
    case "watch":
      await watchCommand(argv, context);
      return;
    case "models":
      await modelsCommand(argv, context);
      return;
    case "catalog":
      await catalogCommand(argv, context);
      return;
    case "refresh":
      await refreshCommand(argv, context);
      return;
    case "interactions":
      await interactionsCommand(argv, context);
      return;
    case "resolve":
      await resolveInteractionCommand(argv, context);
      return;
    case "answer":
      await answerInteractionCommand(argv, context);
      return;
    case "approve":
      await approveInteractionCommand(argv, context);
      return;
    case "describe":
      await describeCommand(argv, context);
      return;
    default:
      throw new UsageError(`unknown command ${quote(command)}; run with --help`);
  }
}

async function sourcesCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  requireNoArguments(parseOptions(argv));
  const sources = await client.sources.list.query();
  if (json) return printJson(sources);
  printSources(sources);
}

async function controlNodesCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  requireNoArguments(parseOptions(argv));
  const controlNodes = await client.controlNodes.list.query();
  if (json) return printJson(controlNodes);
  printControlNodes(controlNodes);
}

async function runtimeNodesCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  requireNoArguments(parseOptions(argv));
  const runtimeNodes = await client.runtimeNodes.list.query();
  if (json) return printJson(runtimeNodes);
  printRuntimeNodes(runtimeNodes);
}

async function sessionsCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set([
      "runtime-node",
      "harness",
      "state",
      "provider",
      "profile",
      "metadata-exists",
      "metadata-equals",
      "activity-after",
      "activity-before",
      "cursor",
      "limit",
    ]),
  );
  requireNoPositionals(parsed);
  const runtimeNodeReference = singleOption(parsed, "runtime-node");
  const harnessValue = singleOption(parsed, "harness");
  const rawStates = optionValues(parsed, "state");
  const providerIds = commaSeparatedOptions(parsed, "provider");
  const profileIds = commaSeparatedOptions(parsed, "profile");
  const metadata = [
    ...optionValues(parsed, "metadata-exists").map((key) => ({
      operator: "exists" as const,
      key: metadataKeySchema.parse(key),
    })),
    ...optionValues(parsed, "metadata-equals").map((encoded) => {
      const [key, value] = splitAssignment(encoded, "--metadata-equals", "=");
      return {
        operator: "equals" as const,
        key: metadataKeySchema.parse(key),
        value: parseJsonValue(value, `--metadata-equals ${key}`),
      };
    }),
  ];
  const input = accessContract.sessions.search.input.parse({
    ...(runtimeNodeReference
      ? {
          runtimeNodeIds: [
            (await resolveRuntimeNode(client, runtimeNodeReference)).runtimeNodeId,
          ],
        }
      : {}),
    ...(harnessValue ? { harnesses: [parseHarness(harnessValue)] } : {}),
    ...(rawStates.length > 0
      ? {
          states: rawStates.flatMap((value) =>
            value
              .split(",")
              .filter(Boolean)
              .map((item) => sessionStateSchema.parse(item)),
          ),
        }
      : {}),
    ...(providerIds.length > 0 ? { providerIds } : {}),
    ...(profileIds.length > 0 ? { profileIds } : {}),
    ...(metadata.length > 0 ? { metadata } : {}),
    ...optionalNamed(parsed, "activity-after", "lastActivityAfter"),
    ...optionalNamed(parsed, "activity-before", "lastActivityBefore"),
    ...optionalNamed(parsed, "cursor", "cursor"),
    ...(singleOption(parsed, "limit")
      ? {
          limit: parsePositiveInteger(
            singleOption(parsed, "limit") ?? "",
            "--limit",
            500,
          ),
        }
      : { limit: 500 }),
  });
  const page = await client.sessions.search.query(input);
  if (json) return printJson(page);
  printSessions(page.sessions);
  if (page.nextCursor !== null) {
    console.error(`more sessions are available; continue with --cursor ${page.nextCursor}`);
  }
}

async function spawnSessionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set([
      "model",
      "approval-policy",
      "sandbox",
      "effort",
      "personality",
      "collaboration-mode",
      "reasoning-effort",
      "mode",
      "additional-directory",
      "native",
      "metadata",
      "provider",
      "profile",
      "contract-version",
      "backend",
    ]),
  );
  requirePositionals(parsed, 3, 3, "spawn <runtime-node> <codex|copilot> <cwd>");
  const runtimeNode = await resolveRuntimeNode(client, parsed.positionals[0] ?? "");
  const harness = parseHarness(parsed.positionals[1] ?? "");
  const cwd = parsed.positionals[2] ?? "";
  const model = singleOption(parsed, "model");
  const native = optionalJsonObject(singleOption(parsed, "native"), "--native");

  const request = harnessSpawnOptionsSchema.parse(
    harness === "codex"
      ? {
          harness,
          cwd,
          ...(model ? { model } : {}),
          ...optionalNamed(parsed, "approval-policy", "approvalPolicy"),
          ...optionalNamed(parsed, "sandbox", "sandbox"),
          ...optionalNamed(parsed, "effort", "effort"),
          ...optionalNamed(parsed, "personality", "personality"),
          ...(singleOption(parsed, "collaboration-mode")
            ? {
                collaborationMode: parseJsonValue(
                  singleOption(parsed, "collaboration-mode") ?? "",
                  "--collaboration-mode",
                ),
              }
            : {}),
          ...(native ? { native } : {}),
        }
      : {
          harness,
          cwd,
          ...(model ? { model } : {}),
          ...optionalNamed(parsed, "reasoning-effort", "reasoningEffort"),
          ...(singleOption(parsed, "mode")
            ? { mode: parseCopilotMode(singleOption(parsed, "mode") ?? "") }
            : {}),
          ...(optionValues(parsed, "additional-directory").length > 0
            ? { additionalDirectories: optionValues(parsed, "additional-directory") }
            : {}),
          ...(native ? { native } : {}),
        },
  );
  assertHarnessOptions(parsed, harness, "spawn");
  const metadata = parseAssignments(optionValues(parsed, "metadata"), "--metadata");
  const profile = await selectLaunchProfile(
    client,
    runtimeNode.runtimeNodeId,
    harness,
    singleOption(parsed, "provider"),
    singleOption(parsed, "profile"),
    singleOption(parsed, "contract-version"),
  );
  const { harness: _harness, ...providerInput } = request;
  const backendId = singleOption(parsed, "backend");
  const input = jsonObjectSchema.parse({
    ...providerInput,
    ...(backendId ? { backendId } : {}),
  });
  const command = launchRequest(
    runtimeNode.runtimeNodeId,
    launchProfileIdentity(profile),
    harness,
    input,
    Object.keys(metadata).length > 0 ? metadataValuesSchema.parse(metadata) : undefined,
  );
  printLaunchRecord(await client.launches.create.mutate(command), json);
}

async function resumeSessionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 1, 1, "resume <session>");
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  printCommandRecord(await client.sessions.resume.mutate(resumeCommand(session)), json);
}

async function promptCommand(
  kind: "send" | "steer",
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set(["prompt-json", "native", "expected-turn", "image"]),
  );
  if (parsed.positionals.length < 1) {
    throw new UsageError(`${kind} requires <session> and a prompt`);
  }
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  const text = parsed.positionals.slice(1).join(" ");
  const encoded = singleOption(parsed, "prompt-json");
  const imagePaths = optionValues(parsed, "image");
  if (!encoded && text.length === 0 && imagePaths.length === 0) {
    throw new UsageError(`provide prompt text, --image <path>, or --prompt-json <json>`);
  }
  if (encoded && text.length > 0) {
    throw new UsageError("prompt text and --prompt-json are mutually exclusive");
  }
  const prompt: JsonValue | string = encoded
    ? parseJsonValue(encoded, "--prompt-json")
    : text;
  const native = optionalJsonObject(singleOption(parsed, "native"), "--native");
  const expectedTurnId = singleOption(parsed, "expected-turn");

  if (imagePaths.length > 0) {
    if (encoded) throw new UsageError("--image and --prompt-json are mutually exclusive");
    if (native && Object.hasOwn(native, "attachments")) throw new UsageError("--image cannot be combined with native.attachments");
    if (imagePaths.length > 10) throw new UsageError("A message supports at most 10 images");
    const runtime = (await client.runtimeNodes.list.query()).find((item) => item.runtimeNodeId === session.runtimeNodeId);
    if (!runtime) throw new UsageError("The session runtime is unavailable");
    const target = imageTarget(session, runtime);
    const descriptors = [];
    let total = 0;
    for (const path of imagePaths) {
      const mediaType = ({ ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" } as Record<string, string>)[extname(path).toLowerCase()];
      if (!mediaType) throw new UsageError("--image supports PNG, JPEG, WebP, and GIF; convert SVGs to raster images before sending");
      const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      let bytes: Buffer;
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size <= 0 || stat.size > 10 * 1_024 * 1_024) throw new UsageError("Image must be a regular file of at most 10 MiB");
        total += stat.size;
        if (total > 50 * 1_024 * 1_024) throw new UsageError("Image attachments exceed 50 MiB");
        bytes = Buffer.alloc(stat.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await handle.read(bytes, offset, bytes.length - offset, offset);
          if (!read.bytesRead) throw new UsageError("Image changed while reading");
          offset += read.bytesRead;
        }
        if ((await handle.stat()).size !== stat.size) throw new UsageError("Image changed while reading");
      } finally {
        await handle.close();
      }
      descriptors.push(await uploadImage(client, target, bytes, mediaType as ImageMediaType));
    }
    const message = imageMessage(session.harness, kind, text, descriptors);
    if (expectedTurnId && message.request.harness !== "codex") throw new UsageError("--expected-turn is Codex-only");
    if (native) Object.assign(message.request.command, { native });
    if (expectedTurnId && kind === "steer") Object.assign(message.request.command, { expectedTurnId });
    printCommandRecord(await client.sessions.execute.mutate(sessionCommand(session, message.request, message.images)), json);
    return;
  }

  let request: HarnessCommand;
  if (session.harness === "codex") {
    if (typeof prompt !== "string" && !Array.isArray(prompt)) {
      throw new UsageError("Codex --prompt-json must be a JSON string or native input array");
    }
    request = harnessCommandSchema.parse({
      harness: "codex",
      command: {
        type: kind,
        input: prompt,
        ...(kind === "steer" && expectedTurnId ? { expectedTurnId } : {}),
        ...(native ? { native } : {}),
      },
    });
  } else {
    if (expectedTurnId) {
      throw new UsageError("--expected-turn is Codex-only");
    }
    if (typeof prompt !== "string" && (prompt === null || Array.isArray(prompt) || typeof prompt !== "object")) {
      throw new UsageError("Copilot --prompt-json must be a JSON string or object");
    }
    request = harnessCommandSchema.parse({
      harness: "copilot",
      command: {
        type: kind,
        prompt,
        mode: kind === "send" ? "enqueue" : "immediate",
        ...(native ? { native } : {}),
      },
    });
  }
  printCommandRecord(
    await client.sessions.execute.mutate(sessionCommand(session, request)),
    json,
  );
}

async function interruptCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv, new Set(["turn"]));
  requirePositionals(parsed, 1, 1, "interrupt <session>");
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  const turnId = singleOption(parsed, "turn");
  if (session.harness === "copilot" && turnId) {
    throw new UsageError("--turn is Codex-only");
  }
  await executeSimple(
    session,
    session.harness === "codex"
      ? {
          harness: "codex",
          command: { type: "interrupt", ...(turnId ? { turnId } : {}) },
        }
      : { harness: "copilot", command: { type: "interrupt" } },
    context,
  );
}

async function stopSessionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 1, 1, "stop <session>");
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  printCommandRecord(
    await client.sessions.stop.mutate(createStopCommand(session)),
    json,
  );
}

async function archiveSessionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 1, 1, "archive <session>");
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  printArchiveRecord(
    await client.sessions.archive.mutate(archiveRequest(session)),
    json,
  );
}

async function setModelCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 2, 2, "model <session> <native-model-id>");
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  const model = parsed.positionals[1] ?? "";
  await executeSimple(
    session,
    session.harness === "codex"
      ? { harness: "codex", command: { type: "setModel", model } }
      : { harness: "copilot", command: { type: "setModel", model } },
    context,
  );
}

async function setModeCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(
    parsed,
    2,
    2,
    "mode <session> <default|plan|codex-native-json|interactive|autopilot>",
  );
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  const mode = parsed.positionals[1] ?? "";
  await executeSimple(
    session,
    session.harness === "codex"
      ? {
          harness: "codex",
          command: {
            type: "setMode",
            mode: mode === "plan" || mode === "default"
              ? mode
              : parseJsonValue(mode, "Codex collaboration mode"),
          },
        }
      : {
          harness: "copilot",
          command: { type: "setMode", mode: parseCopilotMode(mode) },
        },
    context,
  );
}

async function setEffortCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 2, 2, "effort <codex-session> <native-effort>");
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  if (session.harness !== "codex") {
    throw new UsageError(
      "Copilot reasoning effort is selected during spawn/resume and cannot be mutated on an active SDK session",
    );
  }
  await executeSimple(
    session,
    {
      harness: "codex",
      command: { type: "setEffort", effort: parsed.positionals[1] ?? "" },
    },
    context,
  );
}

async function executeSimple(
  session: SessionRecord,
  request: HarnessCommand,
  { client, json }: CommandContext,
): Promise<void> {
  printCommandRecord(
    await client.sessions.execute.mutate(
      sessionCommand(session, harnessCommandSchema.parse(request)),
    ),
    json,
  );
}

async function terminalsCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv, new Set(["limit", "terminate"]), new Set(["clean"]));
  requirePositionals(parsed, 1, 1, "terminals <codex-session>");
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  if (session.harness !== "codex") {
    throw new UsageError("background terminal control is Codex-only");
  }
  const processId = singleOption(parsed, "terminate");
  if (processId && parsed.flags.has("clean")) {
    throw new UsageError("--terminate and --clean are mutually exclusive");
  }
  const limit = parsePositiveInteger(singleOption(parsed, "limit") ?? "100", "--limit", 1_000);
  await executeSimple(
    session,
    {
      harness: "codex",
      command: processId
        ? { type: "terminateBackgroundTerminal", processId }
        : parsed.flags.has("clean")
          ? { type: "cleanBackgroundTerminals" }
          : { type: "listBackgroundTerminals", limit },
    },
    context,
  );
}

async function updateTurnSettingsCommand(
  argv: readonly string[],
  context: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set(["turn", "model", "effort", "summary", "service-tier"]),
    new Set(["default-service-tier"]),
  );
  requirePositionals(parsed, 1, 1, "turn-settings <codex-session>");
  const session = await resolveSession(context.client, parsed.positionals[0] ?? "");
  if (session.harness !== "codex") {
    throw new UsageError("running-turn settings are Codex-only");
  }
  if (singleOption(parsed, "service-tier") && parsed.flags.has("default-service-tier")) {
    throw new UsageError("--service-tier and --default-service-tier are mutually exclusive");
  }
  const model = singleOption(parsed, "model");
  const effort = singleOption(parsed, "effort");
  const summary = singleOption(parsed, "summary");
  const serviceTier = parsed.flags.has("default-service-tier")
    ? null
    : singleOption(parsed, "service-tier");
  if (!model && !effort && !summary && serviceTier === undefined) {
    throw new UsageError("provide --model, --effort, --summary, or a service-tier option");
  }
  await executeSimple(
    session,
    {
      harness: "codex",
      command: {
        type: "updateTurnSettings",
        ...optionalNamed(parsed, "turn", "turnId"),
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
        ...(summary ? { summary } : {}),
        ...(serviceTier !== undefined ? { serviceTier } : {}),
      },
    },
    context,
  );
}

async function metadataCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set(["set", "remove", "if-revision"]),
  );
  if (parsed.positionals.length < 1) {
    throw new UsageError("metadata requires <session>");
  }
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  const assignments = [
    ...parsed.positionals.slice(1),
    ...optionValues(parsed, "set"),
  ];
  const set = parseAssignments(assignments, "metadata assignment");
  const remove = optionValues(parsed, "remove").flatMap((value) =>
    value.split(",").filter(Boolean).map((key) => metadataKeySchema.parse(key)),
  );
  const ifKeyRevision = parseRevisionAssignments(optionValues(parsed, "if-revision"));
  if (
    Object.keys(set).length === 0 &&
    remove.length === 0 &&
    Object.keys(ifKeyRevision).length === 0
  ) {
    const snapshot = await client.metadata.get.query(session.sessionId);
    if (json) return printJson(snapshot);
    printMetadata(snapshot);
    return;
  }
  if (Object.keys(set).length === 0 && remove.length === 0) {
    throw new UsageError("--if-revision must accompany --set or --remove");
  }
  const patch = metadataPatchSchema.parse({
    operationId: newOperationId(),
    sessionId: session.sessionId,
    expectedAuthority: session.metadataAuthority,
    ...(Object.keys(set).length > 0 ? { set } : {}),
    ...(remove.length > 0 ? { remove } : {}),
    ...(Object.keys(ifKeyRevision).length > 0 ? { ifKeyRevision } : {}),
  });
  const result = await client.metadata.patch.mutate(patch);
  if (json) {
    printJson(result);
  } else if (result.status === "accepted") {
    console.log(`metadata accepted at canonical revision ${result.canonical.revision}`);
    printMetadata(result.canonical);
  } else if (result.status === "queued") {
    console.log(
      `metadata queued for authority; canonical revision ${result.canonical.revision}`,
    );
    printMetadata(result.optimistic ?? result.canonical);
  } else if (result.status === "conflicted") {
    console.error("metadata compare-and-set conflict:");
    printTable(
      ["KEY", "EXPECTED", "ACTUAL", "CURRENT VALUE"],
      (result.conflicts ?? []).map((conflict) => [
        conflict.key,
        String(conflict.expectedRevision),
        String(conflict.actualRevision),
        inlineJson(conflict.actualValue),
      ]),
    );
    process.exitCode = 3;
  } else {
    console.error(
      `metadata outcome is unknown; operation ${result.operationId} can be inspected with the access API`,
    );
    printMetadata(result.optimistic ?? result.canonical);
    process.exitCode = 2;
  }
}

async function historyCommand(
  argv: readonly string[],
  { client }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set(["cursor", "limit", "native"]),
    new Set(["all", "no-turns"]),
  );
  requirePositionals(parsed, 1, 1, "history <session>");
  const session = await resolveSession(client, parsed.positionals[0] ?? "");
  if (
    session.harness === "codex" &&
    (parsed.options.has("cursor") || parsed.options.has("limit") || parsed.flags.has("all"))
  ) {
    throw new UsageError("--cursor, --limit, and --all are Copilot-only history options");
  }
  if (session.harness === "copilot" && parsed.flags.has("no-turns")) {
    throw new UsageError("--no-turns is a Codex-only history option");
  }
  const limit = parsePositiveInteger(singleOption(parsed, "limit") ?? "100", "--limit", 1_000);
  const native = optionalJsonObject(singleOption(parsed, "native"), "--native");
  const pages = await readNativeHistoryPages(client, session, {
    cursor: singleOption(parsed, "cursor"),
    limit,
    all: parsed.flags.has("all"),
    includeTurns: !parsed.flags.has("no-turns"),
    native,
  });
  printJson(pages.length === 1 ? pages[0] : pages);
}

interface HistoryOptions {
  readonly cursor?: string | undefined;
  readonly limit: number;
  readonly all: boolean;
  readonly includeTurns: boolean;
  readonly native?: JsonObject | undefined;
}

async function readNativeHistoryPages(
  client: AccessClient,
  session: SessionRecord,
  options: HistoryOptions,
): Promise<NativeHistoryResult[]> {
  if (session.harness === "codex") {
    return [
      await client.sessions.readNativeHistory.query({
        sessionId: session.sessionId,
        request: {
          harness: "codex",
          includeTurns: options.includeTurns,
          ...(options.native ? { native: options.native } : {}),
        },
      }),
    ];
  }

  const pages: NativeHistoryResult[] = [];
  const seenCursors = new Set<string>();
  let cursor = options.cursor;
  do {
    const page = await client.sessions.readNativeHistory.query({
      sessionId: session.sessionId,
      request: {
        harness: "copilot",
        limit: options.limit,
        ...(cursor ? { cursor } : {}),
        ...(options.native ? { native: options.native } : {}),
      },
    });
    pages.push(page);
    if (!options.all || page.complete || !page.nextCursor) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error(`native history returned repeated cursor ${page.nextCursor}`);
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
    if (pages.length >= 10_000) {
      throw new Error("native history exceeded the 10,000-page safety limit");
    }
  } while (true);
  return pages;
}

async function watchCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(
    argv,
    new Set(["history-limit"]),
    new Set(["no-native", "heartbeats"]),
  );
  const sessions = parsed.positionals.length === 0
    ? "all" as const
    : await Promise.all(
        parsed.positionals.map(async (reference) =>
          (await resolveSession(client, reference)).sessionId,
        ),
      );
  const historyLimit = parsePositiveInteger(
    singleOption(parsed, "history-limit") ?? "1000",
    "--history-limit",
    1_000,
  );
  const abort = new AbortController();
  const stop = (): void => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let lastState = "";
  const watcher = watchAccess(client.sessions.watch, {
    sessions,
    includeNative: !parsed.flags.has("no-native"),
    signal: abort.signal,
    onStateChange: (state) => {
      const next = state.state;
      if (next === lastState) return;
      lastState = next;
      if (next === "retrying") {
        console.error(
          `watch disconnected; retrying in ${state.delayMs}ms: ${errorMessage(state.error)}`,
        );
      } else if (next === "live") {
        console.error("watch connected");
      }
    },
    onItem: async (item) => {
      if (item.kind === "heartbeat" && !parsed.flags.has("heartbeats")) return;
      if (json) printNdjson(item);
      else printWatchItem(item);
      if (item.kind === "nativeGap") {
        await recoverNativeGap(client, item, historyLimit, json);
      }
    },
  });
  try {
    await watcher.done;
  } finally {
    watcher.stop();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

async function recoverNativeGap(
  client: AccessClient,
  gap: Extract<AccessStreamItem, { kind: "nativeGap" }>,
  historyLimit: number,
  json: boolean,
): Promise<void> {
  try {
    const session = await requireSession(client, gap.sessionId);
    const pages = await readNativeHistoryPages(client, session, {
      limit: historyLimit,
      all: true,
      includeTurns: true,
    });
    const recovery = {
      kind: "nativeHistoryRecovery" as const,
      sessionId: session.sessionId,
      harness: session.harness,
      reason: gap.reason,
      pages,
    };
    if (json) {
      printNdjson(recovery);
    } else {
      console.log(
        `[history recovered ${shortId(session.sessionId)} via native ${session.harness} API]`,
      );
      printJson(pages.length === 1 ? pages[0] : pages);
    }
  } catch (error) {
    const failure = {
      kind: "nativeHistoryRecoveryFailed" as const,
      sessionId: gap.sessionId,
      error: errorMessage(error),
    };
    if (json) printNdjson(failure);
    else console.error(`[history recovery failed ${shortId(gap.sessionId)}] ${failure.error}`);
  }
}

async function modelsCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 2, 2, "models <runtime-node> <codex|copilot>");
  const runtimeNode = await resolveRuntimeNode(client, parsed.positionals[0] ?? "");
  const harness = parseHarness(parsed.positionals[1] ?? "");
  const models = await client.harness.models.query({
    runtimeNodeId: runtimeNode.runtimeNodeId,
    harness,
  });
  if (json) return printJson(models);
  printTable(
    ["MODEL ID", "NAME", "DESCRIPTION"],
    models.map((model) => [model.id, model.name ?? "", model.description ?? ""]),
  );
}

async function catalogCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 0, 1, "catalog [runtime-node]");
  const runtimeNode = parsed.positionals[0]
    ? await resolveRuntimeNode(client, parsed.positionals[0])
    : undefined;
  const entries = await client.harness.catalog.query(
    runtimeNode ? { runtimeNodeId: runtimeNode.runtimeNodeId } : undefined,
  );
  if (json) return printJson(entries);
  printTable(
    ["HARNESS", "SCOPE", "AVAILABLE", "VERSION", "CAPABILITIES / REASON"],
    entries.map((entry) => [
      entry.harness,
      entry.adapterScopeId,
      entry.available ? "yes" : "no",
      entry.runtimeVersion ?? entry.version ?? "",
      entry.available
        ? entry.capabilities.map((capability) => capability.name).join(", ")
        : entry.unavailableReason ?? "",
    ]),
  );
}

async function refreshCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 1, 1, "refresh <runtime-node>");
  const runtimeNode = await resolveRuntimeNode(client, parsed.positionals[0] ?? "");
  const snapshot = await client.sessions.refresh.mutate({
    runtimeNodeId: runtimeNode.runtimeNodeId,
  });
  if (json) return printJson(snapshot);
  console.log(
    `inventory ${snapshot.generation}: ${snapshot.sessions.length} session(s), ${snapshot.complete ? "complete" : "partial"}`,
  );
  printJson(snapshot);
}

async function interactionsCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv, new Set(), new Set(["all"]));
  requirePositionals(parsed, 0, 1, "interactions [session]");
  const session = parsed.positionals[0]
    ? await resolveSession(client, parsed.positionals[0])
    : undefined;
  const interactions = await client.interactions.list.query({
    ...(session ? { sessionId: session.sessionId } : {}),
    pendingOnly: !parsed.flags.has("all"),
  });
  if (json) return printJson(interactions);
  printInteractions(interactions);
}

async function resolveInteractionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 2, 2, "resolve <interaction> <response-json>");
  const interaction = await resolveInteraction(client, parsed.positionals[0] ?? "");
  const response = parseJsonValue(parsed.positionals[1] ?? "", "interaction response");
  const result = await client.interactions.resolve.mutate({
    interactionId: interaction.interactionId,
    sessionId: interaction.sessionId,
    harness: interaction.harness,
    response,
  });
  printJsonOrSummary(result, json, () => {
    console.log(`interaction ${shortId(result.interactionId)} ${result.state}`);
    printJson(result);
  });
}

async function answerInteractionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv, new Set(["answer"]));
  requirePositionals(parsed, 1, 1, "answer <interaction>");
  const interaction = await resolveInteraction(client, parsed.positionals[0] ?? "");
  if (interaction.requestType !== "userInput") {
    throw new UsageError(`interaction ${shortId(interaction.interactionId)} is not user input`);
  }
  const encodedAnswers = optionValues(parsed, "answer");
  if (encodedAnswers.length === 0) {
    throw new UsageError("provide at least one --answer QUESTION_ID=TEXT");
  }
  const answers: Record<string, { answers: string[] }> = {};
  for (const encoded of encodedAnswers) {
    const [questionId, value] = splitAssignment(encoded, "--answer", "=");
    const entry = answers[questionId] ?? { answers: [] };
    entry.answers.push(value);
    answers[questionId] = entry;
  }
  const result = await client.interactions.resolve.mutate({
    interactionId: interaction.interactionId,
    sessionId: interaction.sessionId,
    harness: interaction.harness,
    response: { answers },
  });
  printJsonOrSummary(result, json, () => {
    console.log(`interaction ${shortId(result.interactionId)} answered`);
  });
}

async function approveInteractionCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  const parsed = parseOptions(argv);
  requirePositionals(parsed, 2, 2, "approve <interaction> <once|session|decline|cancel>");
  const interaction = await resolveInteraction(client, parsed.positionals[0] ?? "");
  if (interaction.requestType !== "approval") {
    throw new UsageError(`interaction ${shortId(interaction.interactionId)} is not an approval`);
  }
  const choice = parsed.positionals[1] ?? "";
  const decision = choice === "once"
    ? "accept"
    : choice === "session"
      ? "acceptForSession"
      : choice === "decline" || choice === "cancel"
        ? choice
        : undefined;
  if (!decision) {
    throw new UsageError("approval decision must be once, session, decline, or cancel");
  }
  const result = await client.interactions.resolve.mutate({
    interactionId: interaction.interactionId,
    sessionId: interaction.sessionId,
    harness: interaction.harness,
    response: { decision },
  });
  printJsonOrSummary(result, json, () => {
    console.log(`interaction ${shortId(result.interactionId)} ${decision}`);
  });
}

async function describeCommand(
  argv: readonly string[],
  { client, json }: CommandContext,
): Promise<void> {
  requireNoArguments(parseOptions(argv));
  const description = await client.system.describe.query();
  if (json) return printJson(description);
  console.log(
    `${description.application} protocol v${description.protocolVersion} ${description.componentKind} ${description.instanceId}`,
  );
  console.log(`data authority: ${description.dataAuthority}`);
  console.log(`capabilities: ${description.capabilities.join(", ")}`);
}

function parseGlobalOptions(argv: readonly string[]): GlobalOptions {
  let httpUrl = process.env.AGENT_MULTIPLEX_HTTP_URL ?? DEFAULT_HTTP_URL;
  let wsUrl = process.env.AGENT_MULTIPLEX_WS_URL;
  let authToken = process.env.AGENT_MULTIPLEX_AUTH_TOKEN;
  let json = false;
  let help = false;
  let version = false;
  const headers: Record<string, string> = parseEnvironmentHeaders();
  const remaining: string[] = [];
  let literal = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (literal) {
      remaining.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      remaining.push(token);
      continue;
    }
    const [name, inline] = splitLongOption(token);
    if (name === "http-url") {
      httpUrl = inline ?? takeGlobalValue(argv, ++index, "--http-url");
    } else if (name === "ws-url") {
      wsUrl = inline ?? takeGlobalValue(argv, ++index, "--ws-url");
    } else if (name === "auth-token") {
      authToken = inline ?? takeGlobalValue(argv, ++index, "--auth-token");
    } else if (name === "header") {
      const encoded = inline ?? takeGlobalValue(argv, ++index, "--header");
      const [headerName, headerValue] = splitAssignment(encoded, "--header", ":", "=");
      headers[headerName] = headerValue;
    } else if (token === "--json" || token === "-j") {
      json = true;
    } else if (token === "--help" || token === "-h") {
      help = true;
    } else if (token === "--version" || token === "-V") {
      version = true;
    } else {
      remaining.push(token);
    }
  }
  if (authToken && Object.keys(headers).length > 0) {
    throw new UsageError(
      "--auth-token/AGENT_MULTIPLEX_AUTH_TOKEN cannot be combined with custom HTTP headers",
    );
  }
  const normalizedHttp = normalizeEndpointUrl(httpUrl, "http:");
  return {
    httpUrl: normalizedHttp,
    wsUrl: normalizeEndpointUrl(wsUrl ?? deriveWebSocketUrl(normalizedHttp), "ws:"),
    headers,
    authToken,
    json,
    help,
    version,
    argv: remaining,
  };
}

function parseEnvironmentHeaders(): Record<string, string> {
  const result: Record<string, string> = {};
  const encoded = process.env.AGENT_MULTIPLEX_HTTP_HEADERS;
  if (encoded) {
    const parsed = parseJsonObject(encoded, "AGENT_MULTIPLEX_HTTP_HEADERS");
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        throw new UsageError("AGENT_MULTIPLEX_HTTP_HEADERS values must be strings");
      }
      result[key] = value;
    }
  }
  return result;
}

function normalizeEndpointUrl(raw: string, defaultProtocol: "http:" | "ws:"): string {
  const withProtocol = raw.includes("://") ? raw : `${defaultProtocol}//${raw}`;
  const url = new URL(withProtocol);
  const allowed = defaultProtocol === "http:"
    ? new Set(["http:", "https:"])
    : new Set(["ws:", "wss:"]);
  if (!allowed.has(url.protocol)) {
    throw new UsageError(
      `${defaultProtocol === "http:" ? "HTTP" : "WebSocket"} endpoint has invalid protocol ${url.protocol}`,
    );
  }
  if (url.pathname === "/" || url.pathname === "") url.pathname = "/trpc";
  if (url.pathname.length > 1 && url.pathname.endsWith("/")) {
    url.pathname = url.pathname.slice(0, -1);
  }
  return url.toString();
}

function deriveWebSocketUrl(httpUrl: string): string {
  const url = new URL(httpUrl);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  else throw new UsageError(`cannot derive WebSocket URL from ${url.protocol}`);
  return url.toString();
}

function parseOptions(
  argv: readonly string[],
  valueOptions: ReadonlySet<string> = new Set(),
  flagOptions: ReadonlySet<string> = new Set(),
): ParsedOptions {
  const positionals: string[] = [];
  const options = new Map<string, string[]>();
  const flags = new Set<string>();
  let literal = false;
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (literal) {
      positionals.push(token);
      continue;
    }
    if (token === "--") {
      literal = true;
      continue;
    }
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }
    const [name, inline] = splitLongOption(token);
    if (!name) throw new UsageError(`invalid option ${quote(token)}`);
    if (flagOptions.has(name)) {
      if (inline !== undefined) throw new UsageError(`--${name} does not take a value`);
      flags.add(name);
      continue;
    }
    if (!valueOptions.has(name)) throw new UsageError(`unknown option --${name}`);
    const value = inline ?? argv[++index];
    if (value === undefined) throw new UsageError(`--${name} requires a value`);
    const values = options.get(name) ?? [];
    values.push(value);
    options.set(name, values);
  }
  return { positionals, options, flags };
}

function splitLongOption(token: string): [string | undefined, string | undefined] {
  if (!token.startsWith("--")) return [undefined, undefined];
  const encoded = token.slice(2);
  const separator = encoded.indexOf("=");
  return separator < 0
    ? [encoded, undefined]
    : [encoded.slice(0, separator), encoded.slice(separator + 1)];
}

function takeGlobalValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (value === undefined) throw new UsageError(`${option} requires a value`);
  return value;
}

function optionValues(parsed: ParsedOptions, name: string): readonly string[] {
  return parsed.options.get(name) ?? [];
}

function commaSeparatedOptions(parsed: ParsedOptions, name: string): string[] {
  return optionValues(parsed, name).flatMap((value) =>
    value.split(",").filter((item) => item.length > 0),
  );
}

function singleOption(parsed: ParsedOptions, name: string): string | undefined {
  const values = optionValues(parsed, name);
  if (values.length > 1) throw new UsageError(`--${name} may only be specified once`);
  return values[0];
}

function optionalNamed(
  parsed: ParsedOptions,
  option: string,
  property: string,
): Record<string, string> {
  const value = singleOption(parsed, option);
  return value ? { [property]: value } : {};
}

function requireNoArguments(parsed: ParsedOptions): void {
  requireNoPositionals(parsed);
}

function requireNoPositionals(parsed: ParsedOptions): void {
  if (parsed.positionals.length > 0) {
    throw new UsageError(`unexpected argument ${quote(parsed.positionals[0] ?? "")}`);
  }
}

function requirePositionals(
  parsed: ParsedOptions,
  minimum: number,
  maximum: number,
  usage: string,
): void {
  if (parsed.positionals.length < minimum || parsed.positionals.length > maximum) {
    throw new UsageError(`usage: agent-multiplex ${usage}`);
  }
}

function assertHarnessOptions(
  parsed: ParsedOptions,
  harness: Harness,
  operation: "spawn",
): void {
  const codex = new Set([
    "approval-policy",
    "sandbox",
    "effort",
    "personality",
    "collaboration-mode",
  ]);
  const copilot = new Set(["reasoning-effort", "mode", "additional-directory"]);
  const invalid = [...(harness === "codex" ? copilot : codex)].filter(
    (name) => parsed.options.has(name),
  );
  if (harness === "codex" && parsed.flags.has("continue-pending-work")) {
    invalid.push("continue-pending-work");
  }
  if (invalid.length > 0) {
    throw new UsageError(`--${invalid[0]} is not supported for ${harness} ${operation}`);
  }
}

function parseHarness(value: string): Harness {
  const result = harnessSchema.safeParse(value);
  if (!result.success) throw new UsageError(`harness must be codex or copilot, got ${quote(value)}`);
  return result.data;
}

function parseCopilotMode(value: string): "interactive" | "plan" | "autopilot" {
  if (value === "interactive" || value === "plan" || value === "autopilot") return value;
  throw new UsageError(`Copilot mode must be interactive, plan, or autopilot`);
}

function parsePositiveInteger(value: string, name: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > maximum) {
    throw new UsageError(`${name} must be an integer from 1 through ${maximum}`);
  }
  return parsed;
}

function parseJsonValue(encoded: string, name: string): JsonValue {
  try {
    return jsonValueSchema.parse(JSON.parse(encoded) as unknown);
  } catch (error) {
    throw new UsageError(`${name} must be valid JSON: ${errorMessage(error)}`);
  }
}

function parseJsonObject(encoded: string, name: string): JsonObject {
  try {
    return jsonObjectSchema.parse(JSON.parse(encoded) as unknown);
  } catch (error) {
    throw new UsageError(`${name} must be a JSON object: ${errorMessage(error)}`);
  }
}

function optionalJsonObject(encoded: string | undefined, name: string): JsonObject | undefined {
  return encoded === undefined ? undefined : parseJsonObject(encoded, name);
}

function parseAssignments(values: readonly string[], name: string): JsonObject {
  const result: JsonObject = {};
  for (const encoded of values) {
    const [key, value] = splitAssignment(encoded, name, "=");
    result[metadataKeySchema.parse(key)] = parseJsonValue(value, `${name} ${key}`);
  }
  return metadataValuesSchema.parse(result);
}

function parseRevisionAssignments(
  values: readonly string[],
): Record<string, number | null> {
  const result: Record<string, number | null> = {};
  for (const encoded of values) {
    const [key, raw] = splitAssignment(encoded, "--if-revision", "=");
    metadataKeySchema.parse(key);
    if (raw === "null") result[key] = null;
    else {
      const revision = Number(raw);
      if (!Number.isSafeInteger(revision) || revision < 0) {
        throw new UsageError(`revision for ${key} must be a non-negative integer or null`);
      }
      result[key] = revision;
    }
  }
  return result;
}

function splitAssignment(
  encoded: string,
  name: string,
  ...separators: readonly string[]
): [string, string] {
  const positions = separators
    .map((separator) => ({ separator, index: encoded.indexOf(separator) }))
    .filter(({ index }) => index > 0)
    .sort((left, right) => left.index - right.index);
  const match = positions[0];
  if (!match) throw new UsageError(`${name} expects NAME${separators[0] ?? "="}VALUE`);
  return [
    encoded.slice(0, match.index),
    encoded.slice(match.index + match.separator.length),
  ];
}

async function resolveRuntimeNode(
  client: AccessClient,
  reference: string,
): Promise<RuntimeNodeDescriptor> {
  const runtimeNodes = await client.runtimeNodes.list.query();
  const parsedId = runtimeNodeIdSchema.safeParse(reference);
  const exact = parsedId.success
    ? runtimeNodes.find((runtimeNode) => runtimeNode.runtimeNodeId === parsedId.data)
    : undefined;
  if (exact) return exact;
  const lowered = reference.toLocaleLowerCase();
  const matches = runtimeNodes.filter(
    (runtimeNode) =>
      runtimeNode.runtimeNodeId.startsWith(reference) ||
      runtimeNode.name.toLocaleLowerCase() === lowered ||
      runtimeNode.name.toLocaleLowerCase().startsWith(lowered),
  );
  return uniqueMatch(matches, "runtime node", reference);
}

async function selectLaunchProfile(
  client: AccessClient,
  runtimeNodeId: RuntimeNodeDescriptor["runtimeNodeId"],
  harness: Harness,
  providerId: string | undefined,
  profileId: string | undefined,
  rawContractVersion: string | undefined,
): Promise<LaunchProfileDescriptor> {
  const contractVersion = rawContractVersion === undefined
    ? undefined
    : parsePositiveInteger(rawContractVersion, "--contract-version", Number.MAX_SAFE_INTEGER);
  const advertised = await client.launchProfiles.list.query({
    runtimeNodeId,
    harness,
    ...(providerId ? { providerId } : {}),
  });
  let matches = advertised.filter(
    (profile) =>
      (profileId === undefined || profile.profileId === profileId) &&
      (contractVersion === undefined || profile.contractVersion === contractVersion),
  );
  if (
    providerId === undefined &&
    profileId === undefined &&
    contractVersion === undefined
  ) {
    const directWorkspace = matches.filter(
      (profile) =>
        profile.providerId === "core.direct" && profile.profileId === "workspace",
    );
    if (directWorkspace.length === 1) matches = directWorkspace;
  }
  if (matches.length === 0) {
    const selection = [providerId, profileId, contractVersion]
      .filter((value) => value !== undefined)
      .join("/");
    throw new Error(
      `launch profile ${quote(selection || `${harness} on ${runtimeNodeId}`)} was not found`,
    );
  }
  if (matches.length > 1) {
    const choices = matches
      .map(
        (profile) =>
          `${profile.providerId}/${profile.profileId}@${profile.contractVersion}`,
      )
      .join(", ");
    throw new UsageError(
      `multiple launch profiles support ${harness}: ${choices}; select one with --provider, --profile, and if needed --contract-version`,
    );
  }
  const selected = matches[0]!;
  if (!selected.available) {
    throw new Error(
      `launch profile ${selected.providerId}/${selected.profileId}@${selected.contractVersion} is unavailable${selected.unavailableReason ? `: ${selected.unavailableReason}` : ""}`,
    );
  }
  return selected;
}

function launchProfileIdentity(profile: LaunchProfileDescriptor): LaunchProfileIdentity {
  return {
    profileId: profile.profileId,
    providerId: profile.providerId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
}

async function resolveSession(client: AccessClient, reference: string): Promise<SessionRecord> {
  const parsedId = sessionIdSchema.safeParse(reference);
  if (parsedId.success) {
    const exact = await client.sessions.get.query(parsedId.data);
    if (exact) return exact;
  }
  const matches: SessionRecord[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.sessions.search.query({
      states: ["running", "stopped", "archived"],
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });
    for (const session of page.sessions) {
      if (
        session.sessionId.startsWith(reference) ||
        session.vendorSessionId === reference ||
        session.vendorSessionId.startsWith(reference)
      ) {
        matches.push(session);
        if (matches.length > 1) break;
      }
    }
    if (matches.length > 1 || page.nextCursor === null) break;
    if (seenCursors.has(page.nextCursor)) {
      throw new Error("session search returned a repeated pagination cursor");
    }
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  } while (true);
  return uniqueMatch(matches, "session", reference);
}

async function requireSession(client: AccessClient, sessionId: string): Promise<SessionRecord> {
  const parsed = sessionIdSchema.parse(sessionId);
  const session = await client.sessions.get.query(parsed);
  if (!session) throw new Error(`session ${sessionId} no longer exists`);
  return session;
}

async function resolveInteraction(
  client: AccessClient,
  reference: string,
): Promise<InteractionRecord> {
  const interactions = await client.interactions.list.query({ pendingOnly: false });
  const parsedId = interactionIdSchema.safeParse(reference);
  const exact = parsedId.success
    ? interactions.find((interaction) => interaction.interactionId === parsedId.data)
    : undefined;
  if (exact) return exact;
  return uniqueMatch(
    interactions.filter((interaction) => interaction.interactionId.startsWith(reference)),
    "interaction",
    reference,
  );
}

function uniqueMatch<T>(matches: readonly T[], kind: string, reference: string): T {
  if (matches.length === 0) throw new Error(`${kind} ${quote(reference)} was not found`);
  if (matches.length > 1) throw new Error(`${kind} ${quote(reference)} is ambiguous (${matches.length} matches)`);
  return matches[0] as T;
}

function printRuntimeNodes(runtimeNodes: readonly RuntimeNodeDescriptor[]): void {
  printTable(
    [
      "PRESENCE",
      "REACHABILITY",
      "NAME",
      "RUNTIME NODE ID",
      "OWNER CONTROL NODE",
      "HARNESSES",
      "ALLOWED ROOTS",
    ],
    runtimeNodes.map((runtimeNode) => [
      runtimeNode.presence,
      runtimeNode.reachability,
      runtimeNode.name,
      runtimeNode.runtimeNodeId,
      shortId(runtimeNode.ownerControlNodeId),
      runtimeNode.harnesses
        .map((entry) => `${entry.harness}:${entry.available ? "ready" : "down"}`)
        .join(","),
      runtimeNode.allowedRoots.join(", "),
    ]),
  );
}

function printControlNodes(controlNodes: readonly ControlNodeDescriptor[]): void {
  printTable(
    ["PRESENCE", "NAME", "CONTROL NODE ID", "ROLE", "LIFECYCLE", "PARENT", "AUTHORITY", "REALM", "EPOCH"],
    controlNodes.map((controlNode) => [
      controlNode.presence,
      controlNode.name,
      controlNode.controlNodeId,
      controlNode.dataRole.role,
      controlNode.dataRole.role === "branch"
        ? controlNode.dataRole.branch.lifecycle
        : "",
      controlNode.dataRole.role === "branch"
        ? shortId(
            controlNode.dataRole.branch.lifecycle === "attached"
              ? controlNode.dataRole.branch.parentControlNodeId
              : controlNode.dataRole.branch.formerParentControlNodeId,
          )
        : "(root)",
      shortId(controlNode.dataRole.authority.controlNodeId),
      shortId(controlNode.dataRole.authority.realmId),
      shortId(controlNode.dataRole.authority.epochId),
    ]),
  );
}

function printSources(sources: readonly SourceDiagnostic[]): void {
  printTable(
    ["STATE", "NAME", "SOURCE ID", "ENDPOINT", "SERVING CONTROL NODE", "PROJECTION ROOT", "COVERAGE", "SELECTED BY", "DETAIL"],
    sources.map((source) => [
      source.state,
      source.displayName,
      source.sourceId,
      source.endpointId,
      source.manifest ? shortId(source.manifest.sourceControlNodeId) : "",
      source.manifest ? shortId(source.manifest.projectionRootControlNodeId) : "",
      source.manifest ? String(source.manifest.coveredControlNodeIds.length) : "",
      source.selectedBySourceId ?? "",
      source.lastError ?? source.reason ?? "",
    ]),
  );
}

function printSessions(sessions: readonly SessionRecord[]): void {
  printTable(
    ["STATE", "AVAILABILITY", "STATUS", "HARNESS", "TITLE", "SESSION ID", "RUNTIME NODE", "CWD"],
    sessions.map((session) => [
      session.catalogState === "archived"
        ? "archived"
        : session.availability === "active"
          ? "running"
          : "stopped",
      session.availability,
      session.runtimeStatus,
      session.harness,
      sessionTitle(session),
      session.sessionId,
      shortId(session.runtimeNodeId),
      session.cwd ?? "",
    ]),
  );
}

function sessionTitle(session: SessionRecord): string {
  const title = session.metadata.values["agent.title"];
  if (typeof title === "string" && title.length > 0) return title;
  return session.vendorSessionId;
}

function printInteractions(interactions: readonly InteractionRecord[]): void {
  printTable(
    ["STATE", "TYPE", "HARNESS", "INTERACTION ID", "SESSION", "PAYLOAD"],
    interactions.map((interaction) => [
      interaction.state,
      interaction.requestType,
      interaction.harness,
      interaction.interactionId,
      shortId(interaction.sessionId),
      inlineJson(interaction.payload),
    ]),
  );
}

function printMetadata(snapshot: MetadataSnapshot): void {
  console.log(`revision ${snapshot.revision}`);
  printTable(
    ["KEY", "KEY REVISION", "VALUE"],
    Object.entries(snapshot.values)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, String(snapshot.keyRevisions[key] ?? 0), inlineJson(value)]),
  );
}

function printCommandRecord(record: CommandRecord, json: boolean): void {
  if (json) {
    printJson(record);
  } else {
    console.log(
      `command ${record.commandId} ${record.state}${record.sessionId ? ` session=${record.sessionId}` : ""}`,
    );
    if (record.result !== undefined) printJson(record.result);
    if (record.error) console.error(record.error);
  }
  if (record.state === "failed" || record.state === "outcomeUnknown") {
    process.exitCode = 2;
  }
}

function printLaunchRecord(record: LaunchRecord, json: boolean): void {
  if (json) {
    printJson(record);
  } else {
    console.log(
      `launch ${record.launchId} ${record.state} session=${record.sessionId} profile=${record.profile.providerId}/${record.profile.profileId}@${record.profile.contractVersion}`,
    );
    if (record.statusMessage) console.log(record.statusMessage);
    if (record.result !== undefined) printJson(record.result);
    if (record.error) console.error(record.error);
  }
  if (record.state === "failed" || record.state === "outcomeUnknown") {
    process.exitCode = 2;
  }
}

function printArchiveRecord(record: ArchiveRecord, json: boolean): void {
  if (json) {
    printJson(record);
  } else {
    console.log(
      `archive ${record.archiveOperationId} ${record.state} session=${record.sessionId}`,
    );
    if (record.releasedAt) console.log(`resources released at ${record.releasedAt}`);
    if (record.error) console.error(record.error);
  }
  if (record.state === "failed" || record.state === "outcomeUnknown") {
    process.exitCode = 2;
  }
}

function printWatchItem(item: AccessStreamItem): void {
  if (item.kind === "heartbeat") {
    console.log(`[heartbeat feed=${shortId(item.feedId)} control=${item.controlCursor}]`);
    return;
  }
  if (item.kind === "streamReset") {
    console.warn(
      `[stream reset feed=${shortId(item.feedId)} control=${item.controlCursor}] ${item.reason}; recovering with ${item.recovery}`,
    );
    return;
  }
  if (item.kind === "nativeGap") {
    console.warn(
      `[native gap ${shortId(item.sessionId)}] ${item.reason}; recovering with ${item.recovery}`,
    );
    return;
  }
  if (item.kind === "native") {
    console.log(
      `[${item.harness} ${shortId(item.sessionId)} #${item.sequence} ${item.nativeType}] ${inlineJson(item.payload)}`,
    );
    return;
  }
  const change = item.change;
  switch (change.type) {
    case "controlNode.upsert":
      console.log(
        `[${item.cursor} control-node] ${change.controlNode.name} ${change.controlNode.presence} role=${change.controlNode.dataRole.role}`,
      );
      return;
    case "controlNode.presence":
      console.log(
        `[${item.cursor} control-node] ${shortId(change.controlNodeId)} ${change.presence}`,
      );
      return;
    case "controlNode.attached":
      console.log(
        `[${item.cursor} control-node] attached ${shortId(change.attachment.childControlNodeId)} -> ${shortId(change.attachment.parentControlNodeId)}`,
      );
      return;
    case "controlNode.detached":
      console.log(
        `[${item.cursor} control-node] detached ${shortId(change.receipt.childControlNodeId)} (${change.receipt.mode})`,
      );
      return;
    case "authority.promoted":
      console.log(
        `[${item.cursor} authority] promoted ${shortId(change.receipt.controlNodeId)} realm=${shortId(change.receipt.authority.realmId)} epoch=${shortId(change.receipt.authority.epochId)}`,
      );
      return;
    case "runtimeNode.upsert":
      console.log(
        `[${item.cursor} runtime-node] ${change.runtimeNode.name} ${change.runtimeNode.presence}`,
      );
      return;
    case "runtimeNode.presence":
      console.log(
        `[${item.cursor} runtime-node] ${shortId(change.runtimeNodeId)} ${change.presence}`,
      );
      return;
    case "session.upsert":
      console.log(
        `[${item.cursor} session] ${shortId(change.session.sessionId)} ${change.session.harness} ${change.session.availability}/${change.session.runtimeStatus}`,
      );
      return;
    case "launch.changed":
      console.log(
        `[${item.cursor} launch] ${shortId(change.launch.launchId)} ${change.launch.state} session=${shortId(change.launch.sessionId)}`,
      );
      return;
    case "archive.changed":
      console.log(
        `[${item.cursor} archive] ${shortId(change.archive.archiveOperationId)} ${change.archive.state} session=${shortId(change.archive.sessionId)}`,
      );
      return;
    case "session.unavailable":
      console.log(`[${item.cursor} session] ${shortId(change.sessionId)} unavailable`);
      return;
    case "metadata.changed":
      console.log(
        `[${item.cursor} metadata] ${shortId(change.sessionId)} revision=${change.metadata.revision} ${inlineJson(change.metadata.values)}`,
      );
      return;
    case "metadata.operation":
      console.log(
        `[${item.cursor} metadata-operation] ${shortId(change.operation.operationId)} ${change.operation.status}`,
      );
      return;
    case "command.changed":
      console.log(
        `[${item.cursor} command] ${shortId(change.command.commandId)} ${change.command.state}`,
      );
      return;
    case "interaction.changed":
      console.log(
        `[${item.cursor} interaction] ${shortId(change.interaction.interactionId)} ${change.interaction.requestType}/${change.interaction.state} ${inlineJson(change.interaction.payload)}`,
      );
      return;
    case "inventory.completed":
      console.log(
        `[${item.cursor} inventory] ${shortId(change.runtimeNodeId)} generation=${change.generation}`,
      );
      return;
  }
}

function printTable(headers: readonly string[], rows: readonly (readonly string[])[]): void {
  if (rows.length === 0) {
    console.log("(none)");
    return;
  }
  // UUIDs are intentionally left copyable in the default human view. Narrow
  // terminals may wrap a row, but silently truncating the primary handle is
  // worse for an operational CLI.
  const cap = Math.max(36, Math.floor((process.stdout.columns ?? 160) / headers.length) - 1);
  const widths = headers.map((header, index) =>
    Math.min(
      Math.max(header.length, ...rows.map((row) => displayCell(row[index] ?? "").length)),
      Math.max(cap, header.length),
    ),
  );
  const render = (cells: readonly string[]): string =>
    cells
      .map((cell, index) => clip(displayCell(cell), widths[index] ?? cap).padEnd(widths[index] ?? cap))
      .join("  ")
      .trimEnd();
  console.log(render(headers));
  console.log(render(widths.map((width) => "-".repeat(width))));
  for (const row of rows) console.log(render(row));
}

function displayCell(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ");
}

function clip(value: string, width: number): string {
  if (value.length <= width) return value;
  if (width < 2) return value.slice(0, width);
  return `${value.slice(0, width - 1)}…`;
}

function shortId(value: string): string {
  return value.length <= 12 ? value : value.slice(0, 8);
}

function inlineJson(value: unknown): string {
  return value === undefined ? "" : JSON.stringify(value);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printNdjson(value: unknown): void {
  console.log(JSON.stringify(value));
}

function printJsonOrSummary(value: unknown, json: boolean, summary: () => void): void {
  if (json) printJson(value);
  else summary();
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : inlineJson(jsonValueSchema.catch("unknown error").parse(error));
}

function quote(value: string): string {
  return JSON.stringify(value);
}

class UsageError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "UsageError";
  }
}

function printHelp(command?: string): void {
  if (command) {
    const detail = COMMAND_HELP[command];
    if (!detail) throw new UsageError(`unknown command ${quote(command)}`);
    console.log(detail);
    return;
  }
  console.log(`Agent Multiplex CLI ${VERSION}

Usage:
  agent-multiplex [global options] <command> [arguments]

Global options:
  --http-url URL         Access HTTP tRPC endpoint (default: ${DEFAULT_HTTP_URL})
  --ws-url URL           Access WebSocket endpoint (derived from --http-url)
  --auth-token TOKEN     Bearer token for both HTTP and WebSocket access
  --header NAME:VALUE    Additional HTTP header; repeatable
  --json, -j             JSON output; watch emits NDJSON
  --help, -h             Show help
  --version, -V          Show version

Environment:
  AGENT_MULTIPLEX_HTTP_URL, AGENT_MULTIPLEX_WS_URL
  AGENT_MULTIPLEX_HTTP_HEADERS='{"header":"value"}'
  AGENT_MULTIPLEX_AUTH_TOKEN (sent as a Bearer token)

Core commands:
  sources                           List access-gateway source diagnostics
  control-nodes                     List the projected control-node tree
  runtime-nodes                     List runtime nodes across the projection
  sessions [filters]                Search running, stopped, or archived sessions
  spawn RUNTIME_NODE HARNESS CWD    Launch a native Codex/Copilot session
  resume SESSION                    Resume a stopped logical session
  send SESSION PROMPT...            Enqueue/start a native prompt
  steer SESSION PROMPT...           Steer the current native turn
  interrupt SESSION                 Interrupt the current turn
  model SESSION MODEL_ID            Change the native model
  mode SESSION MODE                 Change harness-native mode
  effort SESSION EFFORT             Change Codex native reasoning effort
  turn-settings SESSION [options]   Change settings on a running Codex turn
  terminals SESSION [options]       Inspect/control Codex background terminals
  metadata SESSION [KEY=JSON...]    Get or patch flat metadata
  history SESSION [opts]            Read history through the native app server
  watch [SESSION...]                Reconnecting multiplexed access stream

Discovery and interaction commands:
  models RUNTIME_NODE HARNESS       List harness-native models
  catalog [RUNTIME_NODE]            List harness capabilities
  refresh RUNTIME_NODE              Refresh a runtime node's native inventory
  interactions [SESSION]            List pending native interactions
  resolve INTERACTION RESPONSE_JSON Resolve a native interaction
  answer INTERACTION --answer Q=A   Answer a Codex user-input request
  approve INTERACTION DECISION      Resolve a Codex command/file approval
  stop SESSION                      Detach/stop an active native session
  archive SESSION                   Release and archive a stopped session
  describe                          Describe the access endpoint and data role

Runtime-node/session arguments accept an unambiguous UUID prefix; runtime nodes
also accept an unambiguous name and sessions accept a vendor-session prefix.
Run \`agent-multiplex help <command>\` for command-specific options.`);
}

const COMMAND_HELP: Readonly<Record<string, string>> = {
  sources: "Usage: agent-multiplex sources",
  "control-nodes": "Usage: agent-multiplex control-nodes",
  "runtime-nodes": "Usage: agent-multiplex runtime-nodes",
  sessions: `Usage: agent-multiplex sessions [--runtime-node REF] [--harness codex|copilot]
                                [--state running,stopped,archived]
                                [--provider ID]... [--profile ID]...
                                [--metadata-exists KEY]...
                                [--metadata-equals KEY=JSON]...
                                [--activity-after ISO_DATE]
                                [--activity-before ISO_DATE]
                                [--limit 1..500] [--cursor CURSOR]

The default states are running and stopped. Include archived explicitly with
--state archived (or a comma-separated combination). Metadata predicates use
AND semantics and equality is structural JSON equality.`,
  spawn: `Usage: agent-multiplex spawn RUNTIME_NODE codex CWD [--model ID]
       [--approval-policy VALUE] [--sandbox VALUE] [--effort VALUE]
       [--personality VALUE] [--collaboration-mode JSON] [--native OBJECT]
       [--provider ID] [--profile ID] [--contract-version NUMBER]
       [--backend ID]
       [--metadata KEY=JSON]...

   or: agent-multiplex spawn RUNTIME_NODE copilot CWD [--model ID]
       [--reasoning-effort VALUE] [--mode interactive|plan|autopilot]
       [--additional-directory PATH]... [--native OBJECT]
       [--provider ID] [--profile ID] [--contract-version NUMBER]
       [--backend ID]
       [--metadata KEY=JSON]...

With no profile selector, spawn uses the built-in core.direct/workspace profile
when advertised, or the sole matching profile. Multiple matches require an
explicit provider/profile selection.`,
  resume: `Usage: agent-multiplex resume SESSION

Resumes a stopped logical session through the launch provider and native
backend recorded in its immutable launch provenance.`,
  send: `Usage: agent-multiplex send SESSION [PROMPT...]
       [--image PATH]... [--prompt-json JSON] [--native OBJECT]

Codex JSON prompts must be a string or native UserInput array. Copilot JSON
prompts must be a string or native prompt object. Text and --prompt-json are
mutually exclusive. Repeat --image for PNG, JPEG, WebP, or GIF attachments;
image-only messages are supported. --image and --prompt-json are exclusive.
Convert SVGs to raster images before sending. Use -- before text beginning with --.`,
  steer: `Usage: agent-multiplex steer SESSION [PROMPT...]
       [--image PATH]... [--prompt-json JSON] [--native OBJECT] [--expected-turn CODEX_TURN_ID]`,
  interrupt: "Usage: agent-multiplex interrupt SESSION [--turn CODEX_TURN_ID]",
  stop: "Usage: agent-multiplex stop SESSION",
  archive: `Usage: agent-multiplex archive SESSION

Archives a stopped session after its backend and launch provider release any
session-exclusive resources. The operation is durable and may be asynchronous.`,
  model: "Usage: agent-multiplex model SESSION NATIVE_MODEL_ID",
  mode: `Usage: agent-multiplex mode SESSION MODE

Copilot MODE is interactive, plan, or autopilot. Codex accepts the convenient
aliases default and plan, or a complete native collaboration-mode JSON value.`,
  effort: `Usage: agent-multiplex effort CODEX_SESSION NATIVE_EFFORT

Copilot reasoning effort is a spawn/resume option in the current SDK and is not
exposed as an active-session mutation.`,
  "turn-settings": `Usage: agent-multiplex turn-settings CODEX_SESSION
       [--turn TURN_ID] [--model ID] [--effort VALUE] [--summary VALUE]
       [--service-tier VALUE | --default-service-tier]

Uses Codex's experimental turn/settings/update for an already-running turn.`,
  terminals: `Usage: agent-multiplex terminals CODEX_SESSION [--limit 1..1000]
       [--terminate PROCESS_ID | --clean]

Lists app-server background terminals, terminates one native process id, or
cleans every background terminal owned by the thread.`,
  metadata: `Usage: agent-multiplex metadata SESSION [KEY=JSON]...
       [--set KEY=JSON]... [--remove KEY]...
       [--if-revision KEY=NUMBER|null]...

With no patch arguments, prints the canonical metadata snapshot. Keys must be
namespaced (for example agent.title). Values are JSON; quote JSON strings.`,
  history: `Usage: agent-multiplex history SESSION [--all] [--cursor CURSOR]
       [--limit 1..1000] [--no-turns] [--native OBJECT]

Codex calls thread/read. Copilot calls getEvents() and supports pagination.
Payloads are emitted untouched; this CLI never reads vendor session storage.`,
  watch: `Usage: agent-multiplex watch [SESSION...] [--no-native] [--heartbeats]
       [--history-limit 1..1000]

Uses a reconnecting cursor-aware WebSocket subscription. A nativeGap is
recovered and displayed through sessions.readNativeHistory.`,
  models: "Usage: agent-multiplex models RUNTIME_NODE codex|copilot",
  catalog: "Usage: agent-multiplex catalog [RUNTIME_NODE]",
  refresh: "Usage: agent-multiplex refresh RUNTIME_NODE",
  interactions: "Usage: agent-multiplex interactions [SESSION] [--all]",
  resolve: "Usage: agent-multiplex resolve INTERACTION RESPONSE_JSON",
  answer: `Usage: agent-multiplex answer INTERACTION --answer QUESTION_ID=TEXT...

Repeat --answer for multi-select answers or for multiple questions.`,
  approve: "Usage: agent-multiplex approve INTERACTION once|session|decline|cancel",
  describe: "Usage: agent-multiplex describe",
};

await main();
