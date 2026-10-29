import type {
  Thread,
  Turn,
  ThreadItem,
  ModelListResponse,
} from "../../src/codex/native-contracts.js";
import { defaultHandler, type Handler } from "./fixtures.js";

/** Scripted DTOs checked against the exact generated native declarations. */
export const nativeThread = (id = "native-root", parentThreadId: string | null = null): Thread => ({
  id,
  sessionId: parentThreadId ? id : "native-root",
  parentThreadId,
  environments: null,
  extra: null,
  forkedFromId: null,
  preview: "",
  ephemeral: false,
  section: null,
  sectionEnteredAt: null,
  projectId: null,
  historyMode: "paginated",
  modelProvider: "fixture",
  model: "fixture-luna",
  reasoningEffort: null,
  createdAt: 0,
  updatedAt: 0,
  recencyAt: null,
  status: { type: "idle" },
  path: null,
  cwd: "/fixture",
  cliVersion: "0.162.1",
  originator: "multiplex-fixture",
  source: "appServer",
  canAcceptDirectInput: true,
  threadSource: null,
  agentNickname: null,
  agentRole: null,
  gitInfo: null,
  name: null,
  daybreakEnabled: null,
  turns: [],
});
export const nativeTurn = (id = "native-turn", status: Turn["status"] = "inProgress"): Turn => ({
  id,
  rootTurnId: id,
  items: [],
  itemsView: "full",
  status,
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1000,
});
export const nativeMessage = (id = "native-message", text = "native answer"): ThreadItem => ({
  type: "agentMessage",
  id,
  text,
  phase: "final_answer",
  memoryCitation: null,
  delivery: null,
  questions: null,
});
export const nativeModels: ModelListResponse = {
  data: [
    {
      id: "fixture-model-id",
      model: "fixture-luna",
      upgrade: null,
      upgradeInfo: null,
      availabilityNux: null,
      displayName: "Fixture Luna",
      description: "Scripted model",
      modelSpecialty: null,
      hidden: false,
      supportedReasoningEfforts: [
        { reasoningEffort: "low", description: "Low effort" },
        { reasoningEffort: "high", description: "High effort" },
      ],
      defaultReasoningEffort: "low",
      inputModalities: ["text", "image"],
      supportsPersonality: false,
      multiAgentVersion: null,
      additionalSpeedTiers: [],
      serviceTiers: [],
      defaultServiceTier: null,
      availableAccessPrograms: null,
      isDefault: true,
    },
  ],
  nextCursor: null,
};
export const nativeHandler: Handler = (request, wire) => {
  const params = request.params ?? {};
  if (request.method === "thread/start" || request.method === "thread/resume") {
    const result = defaultHandler(request, wire) as Record<string, unknown>;
    return { ...result, thread: nativeThread(String(params.threadId ?? "native-root")) };
  }
  if (request.method === "thread/read")
    return {
      thread: nativeThread(
        String(params.threadId),
        params.threadId === "native-root" ? null : "native-root",
      ),
    };
  if (request.method === "thread/items/list")
    return {
      data: [
        {
          turnId: "stored-turn",
          item: nativeMessage("stored-item", "stored body"),
          startedAtMs: null,
          completedAtMs: null,
        },
      ],
      nextCursor: null,
      backwardsCursor: "native-backwards",
    };
  if (request.method === "thread/turns/list")
    return {
      data: [nativeTurn("stored-turn", "completed")],
      nextCursor: null,
      backwardsCursor: "native-backwards",
    };
  if (request.method === "turn/start") {
    const turn = nativeTurn(`turn-${request.id}`);
    wire.emit({ method: "turn/started", params: { threadId: params.threadId, turn } });
    return { turn };
  }
  if (request.method === "model/list") return nativeModels;
  if (request.method === "thread/queue/add")
    return {
      queuedSubmission: {
        id: "queued-1",
        clientUserMessageId: params.clientUserMessageId,
        input: params.input,
      },
    };
  if (request.method === "thread/queue/start") return { turn: nativeTurn("queued-turn") };
  if (request.method === "thread/queue/list") return { data: [], nextCursor: null };
  return defaultHandler(request, wire);
};
