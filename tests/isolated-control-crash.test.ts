import { Worker } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { describe, it, expect } from "vitest";
import { ControlNodeCatalog, IsolatedRpc } from "@arduano/agent-multiplex-control-node-core";
import { newOperationId } from "@arduano/agent-multiplex-protocol";

describe("isolated authority crash boundaries", () => {
  it.each(["before-commit", "after-commit"])("preserves the stable metadata operation across %s worker exit", async phase => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-owner-crash-"));
    const filename = join(directory, "catalog.sqlite");
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{
        const {ControlNodeCatalog,IsolatedRpc}=await import(workerData.core);
        const {newRuntimeNodeId,newRuntimeNodeBootId,newRuntimeEpoch}=await import(workerData.protocol);
        let armed=false;
        const catalog=new ControlNodeCatalog({filename:workerData.filename,failpoint:point=>{
          if(armed && workerData.phase==='before-commit' && point==='metadata.authority.afterState')process.exit(42);
        }});
        const node=catalog.registerRuntimeNode({runtimeNodeId:newRuntimeNodeId(),runtimeNodeBootId:newRuntimeNodeBootId(),name:'fixture',allowedRoots:['/work'],harnesses:[],protocolVersion:5});
        const [session]=catalog.reconcileInventory({runtimeNodeId:node.runtimeNodeId,generation:workerData.generation,complete:true,capturedAt:new Date().toISOString(),sessions:[{harness:'codex',adapterScopeId:'fixture',vendorSessionId:'fixture',cwd:'/work',availability:'active',runtimeStatus:'idle',runtimeEpoch:newRuntimeEpoch(),lastActivityAt:new Date().toISOString()}]});
        new IsolatedRpc(parentPort,(method,args)=>{
          if(method!=='patch')throw new Error('unknown fixture action');
          armed=true;catalog.submitMetadataPatch(args[0]);process.exit(43);
        });
        parentPort.postMessage({fixtureReady:true,sessionId:session.sessionId,authority:catalog.authority()});
      })();`, { eval: true, workerData: {
        core: new URL("../packages/control-node-core/dist/index.js", import.meta.url).href,
        protocol: new URL("../packages/protocol/dist/index.js", import.meta.url).href,
        filename, phase, generation: randomUUID(),
      } });
    const rpc = new IsolatedRpc(worker, () => undefined);
    worker.once("exit", () => rpc.close());
    let reopened: ControlNodeCatalog | undefined;
    try {
      const ready = await new Promise<any>((resolve, reject) => {
        worker.on("message", message => { if (message.fixtureReady) resolve(message); });
        worker.once("error", reject);
        worker.once("exit", code => reject(new Error(`fixture exited before ready: ${code}`)));
      });
      const operationId = newOperationId();
      const patch = { operationId, sessionId: ready.sessionId, expectedAuthority: ready.authority, set: { "ui.title": "Committed fixture" } };
      await expect(rpc.call("patch", [patch], { mutation: true })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      // Worker exit releases the OS writer lock. No lock file is deleted and no
      // second writer is started merely because the caller deadline elapsed.
      reopened = new ControlNodeCatalog({ filename });
      expect(reopened.getMetadataOperation(operationId)?.status ?? null).toBe(phase === "after-commit" ? "accepted" : null);
      expect(reopened.getMetadata(ready.sessionId).revision).toBe(phase === "after-commit" ? 1 : 0);
      if (phase === "after-commit") {
        const cursor = reopened.controlCursor();
        expect(reopened.submitMetadataPatch(patch).status).toBe("accepted");
        expect(reopened.controlCursor()).toBe(cursor);
        expect(reopened.getMetadata(ready.sessionId).revision).toBe(1);
      }
    } finally { rpc.close(); await worker.terminate(); reopened?.close(); await rm(directory, { recursive: true, force: true }); }
  });
});
