import type { ReferenceOptions, StartReferenceOptions } from "../node-contracts.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import {
  canonicalJson,
  scopeKey,
  type Json,
  type Receipt,
  type RunRef,
  type SessionScope,
} from "../../protocol/index.js";
import { OriginalJournal } from "../../storage/index.js";
import {
  activateHost,
  defineHost,
  defaultLifecycle,
  existingDirectoryWorkspace,
  hostProcedure,
  hostRouter,
  type NativePort,
  type NativeObservation,
} from "../../host/index.js";
import type { OpeningCapsule, OpeningStopProof } from "../../runtime/index.js";
import { HistoryWindow, type HistoryReadPort, type HistoryRecord } from "../../history/index.js";
import { InteractionOwner, type CapabilityRef } from "../../interactions/index.js";
import { preview } from "../../files/index.js";
import { FileStore } from "../../files/node.js";
import { HostAssetOwner, assetRouter } from "../../assets/node.js";
import { ConversationFeature, conversationRouter } from "../../conversation/node.js";
import { Catalog } from "../../catalog/node.js";
import type { CreateRequest, CreationEvidence, HostCreationPort } from "../../catalog/index.js";
import {
  referenceCommandSchema,
  referenceMessageSchema,
  referenceSelectionSchema,
  type ReferenceSelection,
  referenceRunSchema,
  type ReferenceBootstrap,
} from "../contracts.js";
import { Gateway, gatewayHttpHandler } from "../../gateway/node.js";
import { hostTargetSchema } from "../../gateway/contracts.js";
import type { BorrowedBridgePeer } from "../../transport/node-contracts.js";
import { WebSocketServer } from "ws";
import type { Viewer } from "../../gateway/index.js";
import { serve } from "./http.js";

type Slot = {
  capsule: OpeningCapsule;
  run: RunRef;
  window: HistoryWindow;
  interactions: InteractionOwner;
  rows: HistoryRecord[];
  selection: ReferenceSelection;
  stopped: boolean;
  timers: Set<ReturnType<typeof setTimeout>>;
};
const proof = (capsule: OpeningCapsule): OpeningStopProof => ({
  ...capsule,
  state: "stopped",
  scope: "nativeTree",
  noAutomaticContinuation: true,
  acquisitionSealed: true,
});
/** Transparent model-free reference harness. It exercises real framework owners,
 * persistence and transport; none of its generated text is vendor evidence. */
function scriptedNative() {
  const slots = new Map<string, Slot>(),
    parked = new Map<string, OpeningCapsule>();
  let observer: ((value: NativeObservation<ReferenceSelection>) => void) | undefined,
    sequence = 0,
    sends = 0,
    answers = 0;
  const find = (run: RunRef) => {
    const slot = slots.get(scopeKey(run.scope));
    if (
      !slot ||
      slot.run.generation !== run.generation ||
      slot.run.nativeSession !== run.nativeSession
    )
      throw Error("Scripted run fenced");
    return slot;
  };
  const append = (slot: Slot, row: HistoryRecord) => {
    slot.rows.push(row);
    if (slot.rows.length > 512) slot.rows.shift();
    slot.window.update({ rows: [row] });
  };
  const native: NativePort<
    typeof referenceCommandSchema,
    typeof referenceMessageSchema,
    typeof referenceSelectionSchema,
    typeof referenceSelectionSchema
  > = {
    identity: { id: "multiplex.reference-scripted", version: 1, recordVersion: 1 },
    commandInput: referenceCommandSchema,
    messageInput: referenceMessageSchema,
    selectionInput: referenceSelectionSchema,
    selectionOutput: referenceSelectionSchema,
    readiness: () =>
      [...slots.values()].every((slot) => slot.stopped && slot.timers.size === 0)
        ? { ready: true }
        : { ready: false, reasons: ["Scripted sessions remain open"] },
    close() {
      if ([...slots.values()].some((slot) => !slot.stopped || slot.timers.size))
        throw Error("Stop scripted sessions first");
      for (const slot of slots.values()) slot.window.close();
    },
    async prepare(input) {
      const capsule: OpeningCapsule = {
        opening: input.opening,
        identity: {
          attachment: randomUUID(),
          process: `scripted:${input.opening.operationId}`,
          containment: "scripted-only",
          placement: "dedicated",
        },
      };
      parked.set(input.opening.operationId, capsule);
      return { ...capsule, stop: () => native.stop(capsule) };
    },
    async open(input) {
      const run = {
        scope: input.capsule.opening.scope,
        generation: input.capsule.opening.generation,
        nativeSession: input.nativeSession ?? `scripted:${input.capsule.opening.scope.session}`,
      };
      input.commitBinding(run);
      const previous = slots.get(scopeKey(run.scope)),
        window = new HistoryWindow({
          run,
          attachment: input.capsule.identity.attachment,
          stream: "root",
        });
      window.update({
        olderEdge: { state: "end", evidence: "provedEmptyCapture" },
        activity: { state: "idle", turnId: null },
      });
      const slot: Slot = {
        capsule: input.capsule,
        run,
        window,
        interactions: new InteractionOwner(run, input.capsule.identity.attachment, {
          baseline: "complete",
        }),
        rows: previous?.rows ?? [],
        selection: input.selection,
        stopped: false,
        timers: new Set(),
      };
      slots.set(scopeKey(run.scope), slot);
      if (previous?.rows.length)
        window.update({
          rows: previous.rows.slice(-100),
          olderEdge:
            previous.rows.length > 100
              ? { state: "unknown", reason: "Native prefix requires an acquisition baseline" }
              : { state: "end", evidence: "nativeBoundary" },
        });
      return input.mode === "create"
        ? { kind: "created", quiescent: true, run, activity: "idle", selection: slot.selection }
        : { kind: "reopened", run, activity: "idle", selection: slot.selection };
    },
    async inspect(capsule) {
      const slot = slots.get(scopeKey(capsule.opening.scope));
      if (!slot || slot.capsule.identity.attachment !== capsule.identity.attachment)
        return parked.has(capsule.opening.operationId) ? proof(capsule) : null;
      return slot.stopped
        ? proof(capsule)
        : {
            run: slot.run,
            activity: slot.window.getSnapshot().activity.state === "working" ? "working" : "idle",
            selection: slot.selection,
          };
    },
    async stop(capsule) {
      const slot = slots.get(scopeKey(capsule.opening.scope));
      if (slot?.capsule.identity.attachment === capsule.identity.attachment) {
        slot.stopped = true;
        for (const timer of slot.timers) clearTimeout(timer);
        slot.timers.clear();
        slot.window.update({ activity: { state: "idle", turnId: null } });
        slot.interactions.confirmedStopped({
          run: slot.run,
          attachment: capsule.identity.attachment,
          confirmed: true,
        });
      }
      return proof(capsule);
    },
    async send(input) {
      const slot = find(input.run);
      if (slot.stopped) return { state: "refused", result: { reason: "Stopped" } };
      const message = referenceMessageSchema.parse(input.message);
      sends++;
      const turn = `turn:${++sequence}`;
      append(slot, {
        id: `user:${input.originalId}`,
        kind: "user",
        lifecycle: "completed",
        body: { kind: "complete", text: message.text, evidence: "native" },
        native: { originalId: input.originalId, turnId: turn },
      });
      slot.window.update({ activity: { state: "working", turnId: turn } });
      observer?.({ run: slot.run, activity: "working", selection: slot.selection });
      const timer = setTimeout(() => {
        slot.timers.delete(timer);
        if (slot.stopped) return;
        append(slot, {
          id: `assistant:${turn}`,
          kind: "assistant",
          lifecycle: "completed",
          body: {
            kind: "complete",
            text: `Scripted response to: ${message.text}`,
            evidence: "native",
          },
          native: { turnId: turn },
        });
        slot.window.update({ activity: { state: "idle", turnId: turn } });
        observer?.({ run: slot.run, activity: "idle", selection: slot.selection });
      }, 120);
      slot.timers.add(timer);
      return { state: "succeeded", result: { accepted: true, turnId: turn } };
    },
    async command(input) {
      const slot = find(input.run);
      if (slot.stopped) return { state: "refused", result: { reason: "Stopped" } };
      if (input.command.type === "settings") {
        slot.selection = referenceSelectionSchema.parse({
          ...slot.selection,
          ...input.command.patch,
        });
        observer?.({ run: slot.run, activity: "idle", selection: slot.selection });
        return { state: "succeeded", result: { applied: true } };
      }
      if (input.command.type === "answer") {
        const result = await slot.interactions.dispatch(
          input.command.reference,
          input.original,
          input.command.answer,
        );
        return { state: "succeeded", result: { state: result.state, accepted: result.accepted } };
      }
      return { state: "succeeded", result: { continued: true } };
    },
  };
  return {
    native,
    slots,
    observe(fn: (value: NativeObservation<ReferenceSelection>) => void) {
      observer = fn;
    },
    history(run: RunRef) {
      const slot = find(run);
      const port: HistoryReadPort = {
        scope: slot.window.scope,
        mode: "repeatable",
        async read(input, current) {
          current();
          const end = input.cursor === null ? slot.rows.length : Number(input.cursor);
          if (!Number.isSafeInteger(end) || end < 0 || end > slot.rows.length)
            return { status: "expired" };
          const start = Math.max(0, end - input.count);
          return {
            status: "page",
            scope: slot.window.scope,
            placement: input.cursor === null ? "after" : "before",
            rows: slot.rows.slice(start, end),
            nextCursor: start ? String(start) : null,
          };
        },
      };
      return { window: slot.window, port };
    },
    append(scope: SessionScope, text: string) {
      const slot = slots.get(scopeKey(scope));
      if (!slot) throw Error("Unknown scripted session");
      append(slot, {
        id: `fixture:${++sequence}`,
        kind: "assistant",
        lifecycle: "completed",
        body: { kind: "complete", text, evidence: "native" },
        native: {},
      });
    },
    seed(scope: SessionScope, count: number) {
      const slot = slots.get(scopeKey(scope));
      if (!slot) throw Error("Unknown scripted session");
      for (let n = 0; n < count; n++)
        slot.rows.push({
          id: `seed:${n}`,
          kind: n % 2 ? "assistant" : "user",
          lifecycle: "completed",
          body: {
            kind: "complete",
            text: `Reference history ${n + 1}. This is a model-free scripted conversation.\n\n${"Retained history and scrolling are independent of the mounted viewer. ".repeat(3)}`,
            evidence: "native",
          },
          native: {},
        });
      slot.window.update({
        rows: slot.rows.slice(-100),
        olderEdge:
          count > 100
            ? { state: "unknown", reason: "Native prefix requires an acquisition baseline" }
            : { state: "end", evidence: "nativeBoundary" },
      });
    },
    question(scope: SessionScope): CapabilityRef {
      const slot = slots.get(scopeKey(scope));
      if (!slot) throw Error("Unknown scripted session");
      return slot.interactions.capture({
        run: slot.run,
        attachment: slot.capsule.identity.attachment,
        owner: { relation: "root", nativeAgent: slot.run.nativeSession },
        nativeRequestId: `question:${++sequence}`,
        capability: {},
        prompt: {
          type: "codex.question",
          title: "Choose the next step",
          blocking: false,
          questions: [
            {
              id: "approach",
              header: "Approach",
              question: "Which approach should this scripted agent use?",
              secret: false,
              other: true,
              options: [
                { label: "Simple", description: "Prefer the smallest change." },
                { label: "Detailed", description: "Investigate additional evidence." },
              ],
            },
          ],
        },
        async reply() {
          answers++;
          return { kind: "confirmed", accepted: true };
        },
      });
    },
    counts() {
      return {
        sends,
        answers,
        allocated: parked.size,
        live: [...slots.values()].filter((slot) => !slot.stopped).length,
      };
    },
  };
}
/** A failed startup retains its exact cleanup owner when retirement is unproved. */
export class ReferenceStartupError extends AggregateError {
  constructor(
    error: unknown,
    cleanup: unknown,
    readonly retainedClose: () => Promise<void>,
  ) {
    super([error, cleanup], "Reference startup cleanup is unproved");
  }
}
export async function createReference(options: ReferenceOptions) {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  let cleanup: () => Promise<void> = async () => {};
  try {
    const journal = new OriginalJournal({ filename: join(options.directory, "sessions.sqlite") });
    cleanup = async () => {
      journal.close();
    };
    const rootJournal = new OriginalJournal({ filename: join(options.directory, "root.sqlite") });
    cleanup = async () => {
      rootJournal.close();
      journal.close();
    };
    await mkdir(join(options.directory, "files"), { recursive: true, mode: 0o700 });
    const files = await FileStore.open({ directory: join(options.directory, "files") });
    cleanup = async () => {
      files.close();
      rootJournal.close();
      journal.close();
    };
    const assets = new HostAssetOwner({ store: files });
    const scripted = scriptedNative();
    cleanup = async () => {
      await assets.close();
      rootJournal.close();
      journal.close();
    };
    const route = {
      authority: "reference-root",
      host: "scripted-host",
      owner: "reference-owner",
      routeEpoch: randomUUID(),
    };
    const selection = referenceSelectionSchema.parse({
      model: "scripted-small",
      mode: "agent",
      effort: "low",
    });
    const plugin = defaultLifecycle({
      journal,
      workspace: existingDirectoryWorkspace(),
      native: scripted.native,
      selection,
    });
    let feature: ConversationFeature<z.output<typeof referenceCommandSchema>> | undefined;
    const definition = defineHost({
      contract: { id: "multiplex.reference", version: 1 },
      harness: {
        identity: scripted.native.identity,
        nativeKind: "scripted",
        capabilities: ["conversation", "settings", "questions"],
      },
      lifecycle: () => plugin,
      native: ({ sessions }) => {
        const original = z.object({
          id: z.string().min(1).max(256),
          run: referenceRunSchema,
        });
        const scope = (
          ctx: Pick<import("../../host/contracts.js").HostContext, "identity" | "route"> & {
            session?: import("../../host/contracts.js").HostContext["session"] | undefined;
          },
          run: RunRef,
        ) => {
          if (
            ctx.session &&
            (ctx.session.id !== run.scope.session || ctx.session.generation !== run.generation)
          )
            throw Error("Scripted native target fenced");
          return {
            connection: ctx.identity.connection,
            principal: ctx.identity.principal,
            host: ctx.route.host,
            session: run.scope.session,
          };
        };
        return hostRouter({
          send: hostProcedure
            .input(original.extend({ message: referenceMessageSchema }))
            .mutation(({ ctx, input }) =>
              sessions.send(scope(ctx, input.run), input.id, input.message, input.run),
            ),
          control: hostProcedure
            .input(original.extend({ command: referenceCommandSchema }))
            .mutation(({ ctx, input }) =>
              sessions.command(scope(ctx, input.run), input.id, input.command, input.run),
            ),
        });
      },
      extensions: ({ sessions }) => {
        scripted.observe((value) => sessions.observe(value.run.scope, value));
        feature = new ConversationFeature({
          lifecycle: sessions,
          history: (run) => scripted.history(run),
          interactions: (run) => scripted.slots.get(scopeKey(run.scope))?.interactions,
          encodeAnswer: (value) => ({ type: "answer", ...value }),
        });
        return {
          conversation: {
            identity: { id: "multiplex.conversation", version: 1, recordVersion: 1 },
            public: { host: z.null(), session: z.null() },
            router: conversationRouter(feature),
            readiness: () => feature!.readiness(),
            close: () => feature!.close(),
          },
          assets: {
            identity: { id: "multiplex.assets", version: 1, recordVersion: 1 },
            public: { host: z.null(), session: z.null() },
            router: assetRouter(assets),
            readiness: () => assets.readiness(),
            close: () => assets.close(),
          },
        };
      },
    });
    const viewer: Viewer = {
      connection: "reference",
      principal: "local-viewer",
      actions: ["read", "control"],
      hosts: [route.host],
    };
    const host = await activateHost(definition, {
      route,

      authenticate(call) {
        const proof = call.proof;
        if (proof !== viewer) return null;
        return {
          identity: {
            connection: viewer.connection,
            principal: viewer.principal,
            actions: viewer.actions,
          },
          route,
          ...(call.session ? { session: call.session } : {}),
        };
      },
    });
    const sessions = host.sessions;
    const stopOwned = async () => {
      for (const state of sessions.list({ identity: viewer })) {
        if (state.phase !== "stopped" && state.phase !== "archived") {
          const receipt = await sessions.stop(
            state.scope,
            `cleanup:${state.scope.session}:${state.generation}`,
            state.generation,
          );
          if (receipt.state !== "succeeded") throw Error("Reference native retirement is unproved");
        }
      }
    };
    cleanup = async () => {
      await stopOwned();
      await host.close();
      rootJournal.close();
      journal.close();
    };
    const target = {
      owner: route.owner,
      nativeKind: "scripted",
      contractId: host.manifest.contractId,
      contractVersion: host.manifest.contractVersion,
    };
    const exact = (scope: SessionScope, id: string, request: Json, receipt: Receipt | null) => {
      if (
        receipt &&
        (scopeKey(receipt.scope) !== scopeKey(scope) ||
          receipt.id !== id ||
          receipt.requestHash !==
            createHash("sha256").update(canonicalJson(request, 262144).json).digest("hex"))
      )
        throw Error("Reference Host original fenced");
      return receipt;
    };
    const original = (request: CreateRequest) => {
      if (
        request.scope.connection !== viewer.connection ||
        request.scope.principal !== viewer.principal ||
        request.scope.host !== route.host ||
        canonicalJson(request.target as unknown as Json, 8192).json !==
          canonicalJson(target, 8192).json
      )
        throw Error("Reference Root target fenced");
    };
    const evidence = (request: CreateRequest, receipt: Receipt | null): CreationEvidence => {
      const saved = exact(
        request.scope,
        request.id,
        { type: "create", input: request.workspace, selection: request.selection },
        receipt,
      );
      if (!saved || saved.state === "unknown") return { state: "unknown" };
      if (saved.state === "refused") return { state: "refused" };
      if (saved.state !== "succeeded") return { state: "pending" };
      const result = z
        .object({
          opened: z.literal(true),
          run: referenceRunSchema,
          continuationAllowed: z.literal(false),
        })
        .strict()
        .parse(saved.result);
      if (scopeKey(result.run.scope) !== scopeKey(request.scope))
        throw Error("Reference Host binding fenced");
      return { state: "created", binding: result.run };
    };
    const hostCreation: HostCreationPort = {
      async create(request) {
        original(request);
        const workspace = z
          .object({ cwd: z.string().min(1) })
          .strict()
          .parse(request.workspace);
        return evidence(
          request,
          await sessions.create(
            request.scope,
            request.id,
            workspace,
            referenceSelectionSchema.parse(request.selection),
          ),
        );
      },
      async read(request) {
        original(request);
        return evidence(request, sessions.original(request.scope, request.id));
      },
      async readArchive(scope, id, generation) {
        if (
          scope.connection !== viewer.connection ||
          scope.principal !== viewer.principal ||
          scope.host !== route.host
        )
          throw Error("Reference Root scope fenced");
        const saved = exact(
          scope,
          id,
          { type: "archive", generation },
          sessions.original(scope, id),
        );
        return (
          saved?.state === "succeeded" &&
          z
            .object({ archived: z.literal(true) })
            .strict()
            .safeParse(saved.result).success
        );
      },
    };
    const catalog = new Catalog({
      authority: route.authority,
      journal: rootJournal,
      host: () => hostCreation,
    });
    cleanup = async () => {
      await stopOwned();
      await host.close();
      catalog.close();
      rootJournal.close();
      journal.close();
    };
    const createConversation = (
      input: Readonly<{ session: string; id: string; name: string; selection?: Json }>,
    ) =>
      catalog.create({
        scope: {
          connection: viewer.connection,
          principal: viewer.principal,
          host: route.host,
          session: input.session,
        },
        id: input.id,
        target,
        name: input.name,
        workspace: { cwd: options.directory },
        selection: input.selection ?? selection,
      });
    const scopes = ["first", "second"].map((session, n) => ({
      scope: {
        connection: viewer.connection,
        principal: viewer.principal,
        host: route.host,
        session,
      },
      name: n ? "Second conversation" : "Reference conversation",
    }));
    for (const descriptor of scopes) {
      const { scope } = descriptor;
      await createConversation({
        session: scope.session,
        id: `create:${scope.session}`,
        name: descriptor.name,
      });
      descriptor.name = catalog.get(scope)?.name ?? descriptor.name;
      if (options.seed !== false && scripted.slots.has(scopeKey(scope))) scripted.seed(scope, 180);
    }
    const gateway = new Gateway<BorrowedBridgePeer>({
      authorizePeer: (peer) => peer.route.owner === route.owner,
    });
    cleanup = async () => {
      await stopOwned();
      await gateway.close();
      await host.close();
      catalog.close();
      rootJournal.close();
      journal.close();
    };
    const expected = {
      contractId: host.manifest.contractId,
      contractVersion: host.manifest.contractVersion,
      compositionId: host.manifest.compositionId,
    };
    const previews: import("../../files/index.js").Preview[] = [];
    const first = scopes[0]!.scope;
    const pdfText = "BT /F1 18 Tf 30 100 Td (Reference PDF) Tj ET";
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 320 180] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
      `<< /Length ${pdfText.length} >>\nstream\n${pdfText}\nendstream`,
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets = [0];
    for (const [n, object] of objects.entries()) {
      offsets.push(pdf.length);
      pdf += `${n + 1} 0 obj\n${object}\nendobj\n`;
    }
    const xref = pdf.length;
    pdf += `xref\n0 6\n0000000000 65535 f \n${offsets
      .slice(1)
      .map((offset) => String(offset).padStart(10, "0") + " 00000 n \n")
      .join("")}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    const inputs = [
      {
        id: "image",
        name: "Reference.png",
        mediaType: "image/png",
        bytes: Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aP0kAAAAASUVORK5CYII=",
          "base64",
        ),
      },
      {
        id: "html",
        name: "Reference.html",
        mediaType: "text/html",
        bytes: Buffer.from(
          "<h1>Sandboxed reference preview</h1><script>parent.__multiplex_pwned=true</script>",
        ),
      },
      {
        id: "diagram",
        name: "Reference.mmd",
        mediaType: "text/vnd.mermaid",
        bytes: Buffer.from("graph TD; Host-->Gateway; Gateway-->UI;"),
      },
      { id: "pdf", name: "Reference.pdf", mediaType: "application/pdf", bytes: Buffer.from(pdf) },
      {
        id: "text",
        name: "Reference.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("Reference text file preview."),
      },
    ];
    for (const input of inputs) {
      const file = await files.put(
        first,
        { id: input.id, name: input.name, mediaType: input.mediaType, retention: "session" },
        input.bytes,
      );
      previews.push(preview(file, input.bytes));
    }
    const slot = scripted.slots.get(scopeKey(first));
    const mediaRow: HistoryRecord = {
      id: "reference-media",
      kind: "tool",
      lifecycle: "completed",
      body: {
        kind: "complete",
        text:
          "Captured image tool result.\n\n" +
          previews.map((value) => `[${value.file.name}](asset:${value.file.id})`).join(" · "),
        evidence: "native",
      },
      native: {
        assets: previews.map((value) => ({
          id: value.file.id,
          name: value.file.name,
          mediaType: value.file.mediaType,
          state: "ready",
          file: value.file as unknown as Json,
        })),
      },
    };
    if (slot) {
      slot.rows.push(mediaRow);
      slot.window.update({ rows: [mediaRow] });
    }
    const bootstrap: Omit<ReferenceBootstrap, "hostId"> = { route, expected, scopes, previews };
    let closing: Promise<void> | undefined;
    const acquiredCleanup = cleanup;
    const close = () => {
      if (closing) return closing;
      if (!catalog.readiness()) throw Error("Reference Root retains workflow work");
      return (closing = Promise.resolve().then(acquiredCleanup));
    };
    cleanup = close;
    return {
      host,
      sessions,
      catalog,
      createConversation,
      hostCreation,
      scripted,
      gateway,
      assets,
      bootstrap,
      viewer,
      close,
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (failure) {
      throw new ReferenceStartupError(error, failure, cleanup);
    }
    throw error;
  }
}
export type ReferenceRouter = Awaited<ReturnType<typeof createReference>>["host"]["router"];
export async function startReference(options: StartReferenceOptions) {
  const { createReferenceBridge } = await import("./bridge.js");
  const { relayHostBridge } = await import("../../transport/node/p2prpc.js");
  const reference = await createReference(options);
  const token = randomUUID(),
    cookie = `multiplex_reference=${token}`;
  const handle = gatewayHttpHandler(reference.gateway, {
    async authenticate(request) {
      return request.headers.get("cookie")?.split("; ").includes(cookie) ? reference.viewer : null;
    },
  });
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let transport: Awaited<ReturnType<typeof createReferenceBridge>> | undefined;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 2097152,
    perMessageDeflate: false,
  });
  const relays = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Seal the current registrations, including replacements. An older
      // registration's disconnect callback has no authority over a new token.
      const routesClosing = reference.gateway.close();
      for (const socket of sockets.clients) socket.terminate();
      const results = await Promise.allSettled([
        new Promise<void>((resolve, reject) =>
          sockets.close((error) => (error ? reject(error) : resolve())),
        ),
        server?.close(),
        routesClosing,
      ]);
      // Relay errors may be ordinary disconnects; Gateway retains any failed
      // closure proof as a live lease. Reference.close waits that exact owner.
      await Promise.allSettled([...relays]);
      results.push(...(await Promise.allSettled([transport?.close()])));
      results.push(...(await Promise.allSettled([reference.close()])));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Reference cleanup failed",
        );
    })());
  try {
    transport = createReferenceBridge(reference);
    const hostId = await transport.open();
    const bootstrap: ReferenceBootstrap = { ...reference.bootstrap, hostId };
    server = await serve({
      ...(options.assetDirectory ? { assets: options.assetDirectory } : {}),
      ...(options.port === undefined ? {} : { port: options.port }),
      upgrade(request, socket, head) {
        try {
          const origin = `http://${request.headers.host}`;
          const url = new URL(request.url ?? "/", origin);
          const raw = url.searchParams.get("target");
          if (
            url.pathname !== "/host" ||
            request.headers.origin !== origin ||
            !request.headers.cookie?.split("; ").includes(cookie) ||
            !raw ||
            raw.length > 65536
          )
            throw Error("Upgrade denied");
          const target = hostTargetSchema.parse(JSON.parse(raw));
          sockets.handleUpgrade(request, socket, head, (websocket) => {
            const relay = relayHostBridge(reference.gateway, websocket, {
              viewer: reference.viewer,
              target,
            });
            relays.add(relay);
            void relay.finally(() => relays.delete(relay)).catch(() => {});
          });
        } catch {
          socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        }
      },
      async handler(request) {
        if (request.method === "GET" && new URL(request.url).pathname === "/bootstrap")
          return Response.json(bootstrap, {
            headers: {
              "cache-control": "no-store",
              "set-cookie": `${cookie}; HttpOnly; SameSite=Strict; Path=/`,
            },
          });
        return handle(request);
      },
    });
    const activeServer = server;
    return {
      ...reference,
      bootstrap,
      url: activeServer.url,
      bridgeDiagnostics: transport.diagnostics,
      disconnectViewers() {
        for (const socket of sockets.clients) socket.terminate();
        activeServer.server.closeAllConnections();
      },
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (failure) {
      throw new ReferenceStartupError(error, failure, close);
    }
    throw error;
  }
}
