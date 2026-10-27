import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import type { CodexScope, Row } from "../src/contracts/types.js";
import { HistoryHub, HistorySubscription } from "../src/host/history-owner.js";
import { HistoryClient } from "../src/client/history-client.js";
import { createCodexCodec } from "../src/native/codex/index.js";

// The fixture is minimized from real .162.1 events. Identity/path/timestamp
// normalization is declared in its header; provenance pins each original trace.
interface Captured { name: string; rootThreadId: string; children: number; events: { method: string; params: Record<string, unknown> }[] }
const fixture = JSON.parse(await readFile(new URL("../../qualification/fixtures/codex-live-20261023.json", import.meta.url), "utf8")) as { cases: Captured[] };
const body = (row: Row) => row.body.kind === "unavailable" ? null : row.body.text;
for (const captured of fixture.cases) test(`captured real Codex trace: ${captured.name} keeps exact final bytes, partial prefix and scoped ownership`, async () => {
  const origin = { connection:"captured-proof", principal:"owner", host:"codex-fixture", nativeSession:captured.rootThreadId, attachment:"owned" };
  const scope = (threadId=captured.rootThreadId): CodexScope => ({ kind:"codex", origin, threadId });
  const hub = new HistoryHub(), codec=createCodexCodec({ origin, rootThreadId:captured.rootThreadId, capture:hub, knownStart:true });
  const clients=new Map<string,HistoryClient>(), streams=new Map<string,HistorySubscription>(), children=new Set<string>();
  clients.set(captured.rootThreadId,new HistoryClient(scope())); clients.get(captured.rootThreadId)!.view(); streams.set(captured.rootThreadId,hub.watch(scope()));
  let partialSeen=false;
  try {
    for (const event of captured.events) {
      codec.observe(event);
      const item=event.params.item as { type?:string; kind?:string; agentThreadId?:string } | undefined;
      if (item?.type==="subAgentActivity" && item.kind==="started" && item.agentThreadId && !children.has(item.agentThreadId)) {
        children.add(item.agentThreadId); const client=new HistoryClient(scope(item.agentThreadId));client.view();
        clients.set(item.agentThreadId,client);streams.set(item.agentThreadId,hub.watch(scope(item.agentThreadId)));
        assert.equal(codec.threadOwnership(item.agentThreadId)?.ownership.kind,"parentActivity");
        assert.equal(codec.threadOwnership(item.agentThreadId)?.nativeContext,undefined);
      }
      if (event.method==="item/commandExecution/outputDelta") {
        const row=hub.snapshot(scope()).rows.find(row=>row.native.nativeItemId===event.params.itemId);
        assert.ok(row?.body.kind==="partial"&&row.body.missing.includes("prefix"));partialSeen=true;
      }
      for(const [id,stream]of streams)for(const frame of stream.drain())assert.notEqual(clients.get(id)!.apply(frame),"needsSnapshot");
    }
    const current=hub.snapshot(scope());assert.ok(partialSeen);assert.equal(current.coverage.gaps.length,0);assert.equal(children.size,captured.children);
    assert.equal(codec.diagnostics().bufferedEvents,0);assert.deepEqual(clients.get(captured.rootThreadId)!.current,current);
    assert.deepEqual(current.rows.find(row=>row.kind==="tool"&&row.native.type==="commandExecution")!.body,
      {kind:"complete",text:"V8_CDX_FIRST\nV8_CDX_SECOND\n",evidence:"nativeFullBody"});
    assert.ok(current.rows.some(row=>row.kind==="assistant"&&body(row)?.trim()==="V8_CDX_DONE"));
    for(const child of children){
      assert.ok(hub.snapshot(scope(child)).rows.some(row=>row.kind==="assistant"&&body(row)?.trim()==="V8_CDX_CHILD_DONE"));
      assert.ok(!current.rows.some(row=>row.kind==="assistant"&&body(row)?.trim()==="V8_CDX_CHILD_DONE"));
      assert.equal(hub.snapshot(scope(child)).coverage.gaps.length,0);
      assert.ok(current.rows.some(row=>row.kind==="tool"&&row.native.type==="subAgentActivity"&&row.native.agentThreadId===child&&row.body.kind==="unavailable"));
    }
  } finally {for(const stream of streams.values())await stream.return();}
});
