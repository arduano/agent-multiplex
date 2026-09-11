import { Worker, MessageChannel } from "node:worker_threads";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { IsolatedRpc, isolatedStream, IsolatedStreams } from "../src/isolated-rpc.js";

describe("bounded isolated control operations", () => {
  it("retains expired write slots, rejects excess before dispatch and reconciles a real committed SQLite write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-isolated-write-"));
    const filename = join(directory, "operations.sqlite"), latch = new SharedArrayBuffer(4);
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      const {DatabaseSync}=require('node:sqlite');
      (async()=>{const {IsolatedRpc}=await import(workerData.module);
      const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE operations(id TEXT PRIMARY KEY,result TEXT)');
      new IsolatedRpc(parentPort,(method,args)=>{
        if(method==='write') { const existing=db.prepare('SELECT result FROM operations WHERE id=?').get(args[0]); if(existing)return existing;
          db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO operations VALUES(?,?)').run(args[0],'committed');
          Atomics.wait(new Int32Array(workerData.latch),0,0);db.exec('COMMIT');return {result:'committed'}; }
        if(method==='read')return db.prepare('SELECT * FROM operations').all();
        if(method==='close'){db.close();return true;}throw new Error('unknown fixture operation');
      });parentPort.postMessage({fixtureReady:true});})();`, { eval: true, workerData: { module: new URL("../dist/isolated-rpc.js", import.meta.url).href.replace("/test/../dist/", "/dist/"), filename, latch } });
    const rpc = new IsolatedRpc(worker, () => { throw new Error("unexpected reverse call"); }, { pending: 1, timeoutMs: 75 });
    try {
      await new Promise<void>((resolve, reject) => { worker.on("message", message => { if (message.fixtureReady) resolve(); }); worker.once("error", reject); });
      const mutation = rpc.call("write", ["stable-command"], { mutation: true });
      await expect(mutation).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(rpc.diagnostics()).toMatchObject({ pending: 1, expired: 1 });
      await expect(rpc.call("write", ["must-not-be-dispatched"], { mutation: true })).rejects.toMatchObject({ code: "UNAVAILABLE" });
      const reader = new DatabaseSync(filename, { readOnly: true });
      try { expect(reader.prepare("SELECT * FROM operations").all()).toEqual([]); } finally { reader.close(); }
      Atomics.store(new Int32Array(latch), 0, 1); Atomics.notify(new Int32Array(latch), 0);
      await expect.poll(() => rpc.diagnostics().pending).toBe(0);
      expect(await rpc.call("read", [], { timeoutMs: 2_000 })).toEqual([{ id: "stable-command", result: "committed" }]);
      await rpc.call("close");
    } finally { Atomics.store(new Int32Array(latch), 0, 1); Atomics.notify(new Int32Array(latch), 0); rpc.close(); await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
  });
  it("bounds queued bytes independently of request count", async () => {
    const { port1, port2 } = new MessageChannel();
    const rpc = new IsolatedRpc(port1, () => undefined, { pendingBytes: 128, messageBytes: 128, timeoutMs: 10 });
    try {
      const first = rpc.call("fixture", ["x".repeat(70)]).catch(error => error);
      await expect(rpc.call("fixture", ["x".repeat(70)])).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect((await first).code).toBe("UNAVAILABLE");
      expect(rpc.diagnostics().pending).toBe(1);
    } finally { rpc.close(); port1.close(); port2.close(); }
  });
  it("idle pull streams do not expire and replay an initial snapshot", async () => {
    const { port1, port2 } = new MessageChannel(); const streams = new IsolatedStreams();
    let opens = 0;
    const server = new IsolatedRpc(port2, async (method,args) => {
      if (method === "stream.open") { opens++; return streams.open(async function* () { await new Promise(resolve => setTimeout(resolve, 70)); yield "one"; }); }
      if (method === "stream.next") return streams.next(Number(args[0]));
      if (method === "stream.close") return streams.close(Number(args[0]));
    });
    const client = new IsolatedRpc(port1, () => undefined, { timeoutMs: 20 });
    try {
      const values=[]; for await (const value of isolatedStream(client,"fixture",[])) values.push(value);
      expect(values).toEqual(["one"]); expect(opens).toBe(1);
    } finally { streams.closeAll(); client.close(); server.close(); port1.close(); port2.close(); }
  });
  it("owner exit distinguishes reads from potentially admitted writes", async () => {
    const { port1, port2 } = new MessageChannel();
    const rpc = new IsolatedRpc(port1, () => undefined);
    try {
      const read = rpc.call("read").catch(error => error);
      const write = rpc.call("write", [], { mutation: true }).catch(error => error);
      rpc.close();
      expect((await read).code).toBe("UNAVAILABLE");
      expect((await write).code).toBe("OUTCOME_UNKNOWN");
    } finally { rpc.close(); port1.close(); port2.close(); }
  });
  it.each(["io-error", "oversized", "untransferable"])("a %s after mutation dispatch remains uncertain", async kind => {
    const { port1, port2 } = new MessageChannel();
    let dispatched = 0;
    const server = new IsolatedRpc(port2, () => {
      dispatched++;
      if (kind === "io-error") throw new Error("SQLITE_IOERR");
      if (kind === "oversized") return "x".repeat(512);
      return () => undefined;
    }, { messageBytes: 128 });
    const client = new IsolatedRpc(port1, () => undefined);
    try {
      await expect(client.call("mutation", [], { mutation: true })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(dispatched).toBe(1);
    } finally { client.close(); server.close(); port1.close(); port2.close(); }
  });
  it("closes a late stream open without leaking its remote slot", async () => {
    const { port1, port2 } = new MessageChannel(), streams = new IsolatedStreams();
    let release!: () => void, closes = 0;
    const opened = new Promise<void>(resolve => { release = resolve; });
    const server = new IsolatedRpc(port2, async (method, args) => {
      if (method === "stream.open") return streams.openAsync(async () => {
        await opened;
        return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }), return: async () => { closes++; return { done: true, value: undefined }; } }) };
      });
      if (method === "stream.close") return streams.close(Number(args[0]));
    });
    const client = new IsolatedRpc(port1, () => undefined, { timeoutMs: 20 });
    try {
      const iterator = isolatedStream(client, "fixture", [])[Symbol.asyncIterator]();
      await expect(iterator.next()).rejects.toMatchObject({ code: "UNAVAILABLE" });
      expect(client.diagnostics().pending).toBe(1);
      release();
      await expect.poll(() => closes).toBe(1);
      expect(streams.diagnostics().streams).toBe(0);
    } finally { release(); streams.closeAll(); client.close(); server.close(); port1.close(); port2.close(); }
  });
  it("shutdown during stream opening cannot resurrect a slot and close is coalesced", async () => {
    const streams = new IsolatedStreams();
    let release!: () => void, closes = 0;
    const wait = new Promise<void>(resolve => { release = resolve; });
    const opening = streams.openAsync(async () => {
      await wait;
      return { [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }), return: async () => { closes++; return { done: true, value: undefined }; } }) };
    });
    streams.closeAll(); streams.closeAll();
    expect(streams.diagnostics().streams).toBe(1);
    release();
    await expect(opening).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect.poll(() => streams.diagnostics().streams).toBe(0);
    expect(closes).toBe(1);
    expect(() => streams.open(async function* () {})).toThrow(/closing/);
  });

  it("expires queued work before dispatch and retains response credits until consumption", async () => {
    const { port1, port2 } = new MessageChannel();
    let dispatched = 0;
    const responses: any[] = [];
    port1.on("message", message => { if (message.kind === "response") responses.push(message); });
    const server = new IsolatedRpc(port2, () => { dispatched++; return "x".repeat(240); }, { pending: 4, pendingBytes: 512 });
    try {
      port1.postMessage({ kind: "request", id: 1, method: "write", args: [], mutation: true, deadlineAt: Date.now() - 1 });
      await expect.poll(() => responses.length).toBe(1);
      expect(dispatched).toBe(0);
      expect(responses[0].failure.code).toBe("UNAVAILABLE");
      for (let id = 2; id <= 4; id++) port1.postMessage({ kind: "request", id, method: "read", args: [], mutation: false });
      await expect.poll(() => responses.length).toBe(4);
      expect(responses.filter(item => item.result)).toHaveLength(1);
      expect(server.diagnostics().incoming).toBe(3);
      for (let id = 2; id <= 4; id++) port1.postMessage({ kind: "response.ack", id });
      await expect.poll(() => server.diagnostics().incoming).toBe(0);
      expect(server.diagnostics().responseBytes).toBe(0);
    } finally { server.close(); port1.close(); port2.close(); }
  });

  it("contains real SQLITE_FULL without publishing a successful write", async () => {
    const directory = await mkdtemp(join(tmpdir(), "multiplex-isolated-full-"));
    const filename = join(directory, "full.sqlite");
    const worker = new Worker(`
      const {parentPort,workerData}=require('node:worker_threads');
      (async()=>{const {IsolatedRpc}=await import(workerData.module); const {DatabaseSync}=require('node:sqlite');
      const db=new DatabaseSync(workerData.filename); db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE items(id TEXT PRIMARY KEY, bytes BLOB)');
      const pages=db.prepare('PRAGMA page_count').get().page_count; db.exec('PRAGMA max_page_count='+pages);
      new IsolatedRpc(parentPort,method=>{
        if(method==='write')return db.prepare('INSERT INTO items VALUES(?,zeroblob(1000000))').run('stable-full-operation');
        if(method==='read')return db.prepare('SELECT count(*) AS total FROM items').get();
        if(method==='close'){db.close();return;} throw new Error('unknown fixture operation');
      });parentPort.postMessage({fixtureReady:true});})();`, { eval: true, workerData: { module: new URL("../dist/isolated-rpc.js", import.meta.url).href.replace("/test/../dist/", "/dist/"), filename } });
    const rpc = new IsolatedRpc(worker, () => undefined);
    try {
      await new Promise<void>((resolve, reject) => { worker.on("message", value => { if (value.fixtureReady) resolve(); }); worker.once("error", reject); });
      await expect(rpc.call("write", [], { mutation: true })).rejects.toMatchObject({ code: "OUTCOME_UNKNOWN" });
      expect(await rpc.call("read")).toEqual({ total: 0 });
      await rpc.call("close");
    } finally { rpc.close(); await worker.terminate(); await rm(directory, { recursive: true, force: true }); }
  });

});
