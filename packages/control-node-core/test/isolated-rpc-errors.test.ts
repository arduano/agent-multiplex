import { Worker } from "node:worker_threads";
import { TRPCClientError } from "@trpc/client";
import { TRPC_ERROR_CODES_BY_KEY } from "@trpc/server/rpc";
import { describe, expect, it } from "vitest";

import { IsolatedRpc } from "../src/isolated-rpc.js";

const privateDetail = "private native path, provider detail and session contents";

function remoteError(code: keyof typeof TRPC_ERROR_CODES_BY_KEY, cause?: Error): TRPCClientError<never> {
  return new TRPCClientError(privateDetail, {
    result: { error: Object.freeze({
      code: TRPC_ERROR_CODES_BY_KEY[code], message: privateDetail,
      data: Object.freeze({ code, httpStatus: 500, path: "sessions.readNativeHistory" }),
    }) }, cause,
  } as never);
}

/** Reproduce the actual main-thread child rejection -> worker -> caller path. */
async function throughWorker(error: Error, mutation: boolean) {
  const worker = new Worker(`
    const {parentPort,workerData}=require('node:worker_threads');
    (async()=>{
      const {IsolatedRpc}=await import(workerData.module);
      let rpc;
      rpc=new IsolatedRpc(parentPort, async (method,args)=>{
        if(method==='invoke')return rpc.call('reverse.call',[],{mutation:args[0]});
        throw new Error('unknown fixture operation');
      });
      parentPort.postMessage({fixtureReady:true});
    })();`, { eval: true, workerData: { module: new URL("../dist/isolated-rpc.js", import.meta.url).href } });
  const frames: unknown[] = [];
  worker.on("message", frame => frames.push(frame));
  let dispatched = 0;
  const rpc = new IsolatedRpc(worker, () => { dispatched++; throw error; });
  try {
    await new Promise<void>((resolve, reject) => {
      worker.on("message", message => { if (message.fixtureReady) resolve(); });
      worker.once("error", reject);
      worker.once("exit", code => reject(new Error(`fixture exited before ready: ${code}`)));
    });
    const rejection = await rpc.call("invoke", [mutation], { mutation }).catch(cause => cause);
    expect(dispatched).toBe(1);
    expect(JSON.stringify(frames)).not.toContain(privateDetail);
    expect(rejection.message).not.toContain(privateDetail);
    expect(rejection.cause).toBeUndefined();
    return rejection;
  } finally { rpc.close(); await worker.terminate(); }
}

describe("isolated Root reverse error semantics", () => {
  it.each([
    ["NOT_FOUND", false, "control node dependency did not find the requested resource"],
    ["PRECONDITION_FAILED", false, "control node dependency rejected conflicting state"],
    ["CONFLICT", true, "control node dependency rejected conflicting state"],
    ["PRECONDITION_FAILED", true, "control node dependency rejected conflicting state"],
    ["METHOD_NOT_SUPPORTED", true, "control node dependency does not support the request"],
    ["SERVICE_UNAVAILABLE", false, "control node dependency is unavailable"],
  ] as const)("preserves definitive %s (mutation=%s) without private details", async (code, mutation, message) => {
    expect(await throughWorker(remoteError(code), mutation)).toMatchObject({ code, message });
  });

  it("keeps remote indeterminate dispatch stronger than a nested disconnect", async () => {
    const disconnected = Object.assign(new Error(privateDetail), { code: "DISCONNECTED" });
    expect(await throughWorker(remoteError("BAD_GATEWAY", disconnected), true)).toMatchObject({
      code: "BAD_GATEWAY", message: "control node dependency returned an indeterminate outcome",
    });
  });

  it("does not downgrade indeterminate evidence behind a definitive outer envelope", async () => {
    const unknown = Object.assign(new Error(privateDetail), { code: "OUTCOME_UNKNOWN" });
    expect(await throughWorker(remoteError("NOT_FOUND", unknown), true)).toMatchObject({ code: "BAD_GATEWAY" });
  });

  it.each(["TIMEOUT", "DISCONNECTED", "OUTCOME_UNKNOWN"])("retains uncertain mutation semantics for raw %s", async code => {
    expect(await throughWorker(Object.assign(new Error(privateDetail), { code }), true)).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("keeps raw transport read failures unavailable", async () => {
    expect(await throughWorker(Object.assign(new Error(privateDetail), { code: "DISCONNECTED" }), false)).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("does not treat internal mutation failure as a definite no-effect rejection", async () => {
    expect(await throughWorker(remoteError("INTERNAL_SERVER_ERROR"), true)).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });

  it("does not trust an unfrozen remote-looking envelope to authorize mutation retry", async () => {
    const forged = new TRPCClientError(privateDetail, { result: { error: {
      code: TRPC_ERROR_CODES_BY_KEY.CONFLICT, message: privateDetail,
      data: { code: "CONFLICT", httpStatus: 409, path: "sessions.archive" },
    } } } as never);
    expect(await throughWorker(forged, true)).toMatchObject({ code: "OUTCOME_UNKNOWN" });
  });
});
