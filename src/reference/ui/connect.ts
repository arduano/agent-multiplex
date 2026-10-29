import { AttachmentOwner } from "../../attachments/index.js";
import { z } from "zod";
import { assetFileReadPort, type AssetRemote } from "../../assets/index.js";
import { RetainedWorkspace, type Command, type EntrySnapshot } from "../../client/index.js";
import { createConversationFeed, subscriptionStream } from "../../conversation/index.js";
import type { Json } from "../../protocol/index.js";
import { scopeKey } from "../../protocol/index.js";
import { ObservationSupervisor } from "../../transport/index.js";
import {
  referenceCommandSchema,
  referenceMessageSchema,
  referenceScopeSchema,
  type ReferenceCommand,
  type ReferenceRouter,
} from "../index.js";
import type { Preview } from "../../files/index.js";
import { mountReferenceApp } from "./app.js";
import type { ControlChoice, Conversation, ReferenceUiOptions } from "./contracts.js";

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const record = (value: Json | undefined): value is Readonly<Record<string, Json>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const stored = z
  .object({
    kind: z.literal("stored"),
    scope: referenceScopeSchema,
    id: z.string().min(1).max(256),
    name: z.string().min(1).max(256),
    bytes: z.number().int().min(0).max(33554432),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mediaType: z.string().min(1).max(256),
    origin: z.enum(["upload", "capture"]),
    retention: z.enum(["session", "cache"]),
  })
  .strict();
/** Concrete reference composition of real public browser boundaries. Typed
 * calls remain typed all the way to ReferenceRouter; no procedure path table. */
export async function connectReferenceUi(options: ReferenceUiOptions<ReferenceRouter>) {
  const { bootstrap } = options;
  const client = options.peer.rpc;
  const feed = createConversationFeed({
    caller() {
      const remote = client.extensions.conversation;
      return {
        stateWatch: (input, unavailable) =>
          subscriptionStream(
            (observer) => remote.stateWatch.subscribe(input, observer),
            unavailable,
          ),
        historyWatch: (input, unavailable) =>
          subscriptionStream(
            (observer) => remote.historyWatch.subscribe(input, observer),
            unavailable,
          ),
        interactionsWatch: (input, unavailable) =>
          subscriptionStream(
            (observer) => remote.interactionsWatch.subscribe(input, observer),
            unavailable,
          ),
        baseline: (input) => remote.baseline.query(input),
        older: (input) => remote.older.query(input),
        original: (input) => remote.original.query(input),
      };
    },
    dispatch(scope, command) {
      const session = scope.session;
      if (command.kind === "stop")
        return client.lifecycle.stop.mutate({
          session,
          id: command.id,
          generation: command.payload.generation,
        });
      if (command.kind === "send")
        return client.native.send.mutate({
          id: command.id,
          message: referenceMessageSchema.parse(command.payload),
          run: command.run,
        });
      if (command.kind !== "control") throw new Error("REFERENCE_COMMAND_UNSUPPORTED");
      return client.native.control.mutate({
        id: command.id,
        command: referenceCommandSchema.parse(command.payload),
        run: command.run,
      });
    },
  });
  const observations = new ObservationSupervisor({ retryMinMs: 100, retryMaxMs: 1000 }),
    workspace = new RetainedWorkspace({ feed, observations, persistence: options.persistence });
  const attachmentOwners: AttachmentOwner[] = [];
  let mounted: ReturnType<typeof mountReferenceApp> | undefined;
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      mounted?.close();
      const results = await Promise.allSettled(attachmentOwners.map((owner) => owner.close()));
      await workspace.settled();
      results.push(...(await Promise.allSettled([workspace.close(), observations.close()])));
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length)
        throw new AggregateError(
          failures.map((result) => result.reason),
          "Reference UI cleanup failed",
        );
    })());
  try {
    await workspace.restore();
    const conversations = bootstrap.scopes.map((descriptor): Conversation => {
      const view = workspace.view(descriptor.scope),
        remote = client.extensions.assets;
      const assets: AssetRemote = {
        begin: (input) => remote.begin.mutate(input),
        status: (input) => remote.status.query(input),
        abort: (input) => remote.abort.mutate(input),
        acquire: (input) => remote.acquire.query(input),
      };
      const previews =
          bootstrap.previews?.filter(
            (value) => scopeKey(value.file.scope) === scopeKey(descriptor.scope),
          ) ?? [],
        files = assetFileReadPort(assets, options.peer.files);
      const attachments = new AttachmentOwner(view.entry, assets, options.peer.files);
      attachmentOwners.push(attachments);
      const draft = (text: string, snapshot: EntrySnapshot): Command => {
        if (!snapshot.state?.run) throw new Error("REFERENCE_RUN_UNAVAILABLE");
        return {
          id: crypto.randomUUID(),
          kind: "send",
          run: snapshot.state.run,
          payload: json(
            referenceMessageSchema.parse({
              text,
              attachments: snapshot.attachments.map((file) => ({ id: file.id })),
            }),
          ),
          optimisticText: text,
        };
      };
      const control = (command: ReferenceCommand, snapshot: EntrySnapshot): Command => {
        if (!snapshot.state?.run) throw new Error("REFERENCE_RUN_UNAVAILABLE");
        return {
          id: crypto.randomUUID(),
          kind: "control",
          run: snapshot.state.run,
          payload: json(command),
        };
      };
      return {
        id: descriptor.scope.session,
        name: descriptor.name,
        view,
        files,
        attachments,
        ...(options.renderDiagram ? { renderDiagram: options.renderDiagram } : {}),
        markdownFiles: Object.fromEntries(
          previews.map((value) => [`asset:${value.file.id}`, value]),
        ),
        media(row) {
          const assets = Array.isArray(row.native.assets) ? row.native.assets : [];
          return assets.flatMap((asset) => {
            if (!record(asset) || asset.state !== "ready") return [];
            const parsed = stored.safeParse(asset.file);
            if (!parsed.success || scopeKey(parsed.data.scope) !== scopeKey(descriptor.scope))
              return [];
            const file = parsed.data;
            const original = previews.find(
              (value) => value.file.id === file.id && value.file.sha256 === file.sha256,
            );
            const preview: Preview =
              original ??
              (file.bytes > 16777216
                ? { kind: "download", file, reason: "too-large" }
                : file.mediaType.startsWith("image/") && file.mediaType !== "image/svg+xml"
                  ? { kind: "image", file }
                  : file.mediaType === "application/pdf"
                    ? { kind: "pdf", file }
                    : { kind: "download", file, reason: "unsupported" });
            return [{ preview }];
          });
        },
        actions: {
          draft,
          stop: (snapshot) => ({
            id: crypto.randomUUID(),
            kind: "stop" as const,
            run: snapshot.state?.run ?? null,
            payload: { generation: snapshot.state?.run?.generation ?? 0 },
          }),
          async respond(reference, answer) {
            const handle = await view.submit(
              control({ type: "answer", reference, answer }, view.entry.getSnapshot()),
            );
            const result = await handle.settled;
            if (result.state === "refused" || result.state === "localFailure")
              throw new Error("REFERENCE_RESPONSE_REFUSED");
          },
          implementPlan: {
            available(_row, snapshot) {
              const selection = snapshot.state?.selection;
              return (
                record(selection) &&
                selection.mode === "plan" &&
                snapshot.state?.activity === "idle" &&
                snapshot.history.current?.scope.stream === "root"
              );
            },
            async invoke(row, snapshot) {
              if (row.body.kind !== "complete") throw new Error("REFERENCE_PLAN_INCOMPLETE");
              const handle = await view.submit(draft(row.body.text, snapshot));
              await handle.settled;
            },
          },
        },
        controls(snapshot): readonly ControlChoice[] {
          const selection = snapshot.state?.selection,
            values = record(selection) ? selection : {};
          const choices = [
            { id: "model", label: "Model", options: ["scripted-small", "scripted-large"] },
            { id: "mode", label: "Mode", options: ["agent", "plan"] },
            { id: "effort", label: "Reasoning", options: ["low", "high"] },
          ];
          return choices.map((choice) => ({
            id: choice.id,
            label: choice.label,
            value: typeof values[choice.id] === "string" ? (values[choice.id] as string) : "",
            options: choice.options.map((value) => ({ value, label: value })),
            disabled: snapshot.freshness !== "current" || snapshot.state?.phase !== "running",
            prepare: (value, current) =>
              control(
                referenceCommandSchema.parse({ type: "settings", patch: { [choice.id]: value } }),
                current,
              ),
          }));
        },
      };
    });
    mounted = mountReferenceApp(options.element, {
      conversations,
      theme: options.theme ?? "light",
      title: "Agent Multiplex · scripted reference",
    });
    return {
      workspace,
      conversations,
      observations,
      close,
    };
  } catch (error) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], "Reference UI startup cleanup failed", {
        cause: cleanup,
      });
    }
    throw error;
  }
}
