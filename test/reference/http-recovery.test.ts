import { referenceMessageSchema } from "../../src/reference/contracts.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startReference } from "../../src/reference/node.js";
import type { ReferenceRouter } from "../../src/reference/index.js";
import { bridgeHostUrl, ObservationSupervisor } from "../../src/transport/index.js";
import { connectBridge } from "@arduano/p2prpc-core/browser";
import WebSocket from "ws";
import { RetainedWorkspace } from "../../src/client/index.js";
import { createConversationFeed, subscriptionStream } from "../../src/conversation/index.js";
import { scopeKey } from "../../src/protocol/index.js";
import { Persistence } from "../client/fixture.js";

async function observed(ready: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!ready()) {
    if (Date.now() >= deadline) throw Error("HTTP recovery boundary did not arrive");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test(
  "actual browser bridge outage heals retained conversations without replay; route registration replacement fences the old carrier",
  { timeout: 60000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-trpc-recovery-"));
    let acquired: Awaited<ReturnType<typeof startReference>> | undefined;
    let workspace: RetainedWorkspace | undefined, release: (() => void) | undefined;
    let peer: Awaited<ReturnType<typeof connectBridge<ReferenceRouter>>> | undefined;
    const observations = new ObservationSupervisor({ retryMinMs: 10, retryMaxMs: 30 });
    try {
      const app = await startReference({ directory, seed: false });
      acquired = app;
      const bootstrap = await fetch(new URL("/bootstrap", app.url));
      const cookie = bootstrap.headers.get("set-cookie")!.split(";", 1)[0]!;
      let online = true,
        targetResolutions = 0;
      const target = { route: app.bootstrap.route, expected: app.bootstrap.expected };
      peer = await connectBridge<ReferenceRouter>({
        url: bridgeHostUrl(app.url, target),
        expectedHostId: app.bootstrap.hostId,
        socket(url) {
          targetResolutions++;
          if (!online) throw Error("Owned network interruption");
          return new WebSocket(url, { headers: { cookie, origin: app.url } });
        },
      });
      const client = () => peer!.rpc;
      const remote = () => client().extensions.conversation;
      const feed = createConversationFeed({
        caller: () => ({
          stateWatch: (input, unavailable) =>
            subscriptionStream(
              (observer) => remote().stateWatch.subscribe(input, observer),
              unavailable,
            ),
          historyWatch: (input, unavailable) =>
            subscriptionStream(
              (observer) => remote().historyWatch.subscribe(input, observer),
              unavailable,
            ),
          interactionsWatch: (input, unavailable) =>
            subscriptionStream(
              (observer) => remote().interactionsWatch.subscribe(input, observer),
              unavailable,
            ),
          baseline: (input) => remote().baseline.query(input),
          older: (input) => remote().older.query(input),
          original: (input) => remote().original.query(input),
        }),
        dispatch(scope, command) {
          assert.equal(command.kind, "send");
          assert(command.run);
          return client().native.send.mutate({
            id: command.id,
            run: command.run,
            message: referenceMessageSchema.parse(command.payload),
          });
        },
      });
      workspace = new RetainedWorkspace({ feed, observations, persistence: new Persistence() });
      const scope = app.bootstrap.scopes[0]!.scope,
        view = workspace.view(scope);
      release = view.commit();
      await observed(
        () =>
          view.entry.getSnapshot().freshness === "current" &&
          view.entry.getSnapshot().historyFreshness === "current",
      );
      const original = {
        id: "once-through-http",
        kind: "send" as const,
        run: view.entry.getSnapshot().state!.run!,
        payload: { text: "one exact scripted Send" },
      };
      const sent = await view.submit(original);
      await sent.settled;
      await observed(
        () =>
          app.scripted.counts().sends === 1 && view.entry.getSnapshot().state?.activity === "idle",
      );
      const receipt = await remote().original.query({ session: scope.session, id: original.id });
      assert.equal(receipt?.state, "succeeded");
      const nativeBefore = app.scripted.counts();
      online = false;
      app.disconnectViewers();
      await observed(
        () =>
          view.entry.getSnapshot().freshness === "unavailable" &&
          view.entry.getSnapshot().historyFreshness === "unavailable",
      );
      const slot = app.scripted.slots.get(scopeKey(scope))!;
      slot.window.update({
        rows: [
          {
            id: "captured-during-outage",
            kind: "assistant",
            lifecycle: "completed",
            body: {
              kind: "complete",
              text: "captured while browser disconnected",
              evidence: "native",
            },
            native: {},
          },
        ],
      });
      online = true;
      await observed(
        () =>
          view.entry.getSnapshot().freshness === "current" &&
          view.entry.getSnapshot().history.rows.some((row) => row.id === "captured-during-outage"),
      );
      assert.deepEqual(app.scripted.counts(), nativeBefore);
      assert.deepEqual(
        await remote().original.query({ session: scope.session, id: original.id }),
        receipt,
      );
      const resolutionsBeforeEpoch = targetResolutions;
      const held = app.gateway.acquire(app.viewer, target);
      const transport = held.transport;
      held.release();
      app.gateway.registerHost({ route: target.route, manifest: app.host.manifest, transport });
      await observed(
        () =>
          targetResolutions > resolutionsBeforeEpoch &&
          view.entry.getSnapshot().freshness === "current" &&
          view.entry.getSnapshot().historyFreshness === "current",
      );
      assert.deepEqual(
        await remote().original.query({ session: scope.session, id: original.id }),
        receipt,
      );
      assert.deepEqual(view.entry.getSnapshot().originals[0]!.command, original);
      assert.deepEqual(app.scripted.counts(), nativeBefore);
    } finally {
      release?.();
      await workspace?.settled();
      await workspace?.close();
      await observations.close();
      await peer?.close();
      await acquired?.close();
      if (acquired) {
        assert.equal(acquired.gateway.readiness(), true);
        assert.deepEqual(acquired.bridgeDiagnostics(), {
          closed: true,
          admitting: 0,
          tasks: 0,
          channels: 0,
          peers: 0,
          entries: [],
        });
      }
      await rm(directory, { recursive: true, force: true });
    }
  },
);
