import assert from "node:assert/strict";
import { test } from "node:test";
import type { NativeEvent, NativeOutcome, NativeRun, NativeStart, RunRef } from "../src/contracts/types.js";
import { defer, fixture, scope, ScriptedPort } from "./host-fixture.js";

test("Host Running publication releases only completed native opening admission before Create receipt IO; first Send from subscriber is not busy", async () => {
  const owned = defer<void>(), initialized = defer<void>(), nativeSend = defer<void>(), sendResult = defer<NativeOutcome>();
  class EarlyPort extends ScriptedPort {
    override async start(input: NativeStart, emit: (event: NativeEvent) => void, onOwned?: (run: NativeRun) => Promise<void>): Promise<NativeRun> {
      const initial = await super.start(input, emit);
      await onOwned?.({ ...initial, initializationComplete: false }); owned.resolve();
      await initialized.promise; this.complete = true; this.interactions = [];
      return { ...this.handle(), initializationComplete: true };
    }
    override handle(run?: RunRef): NativeRun {
      const handle = super.handle(run);
      return { ...handle, invoke: command => { const result = handle.invoke(command); if (command.type === "send") nativeSend.resolve(); return result; } };
    }
  }
  const port = new EarlyPort(); port.complete = false; port.interactions = [{ id: "initial-question", owner: "root", kind: "userInput", choices: ["submit"] }];
  const f = await fixture(port); let sent: ReturnType<typeof f.host.submit> | undefined, createSettled = false, submittedBeforeCreateSettled = false;
  const unsubscribe = f.host.subscribe(scope, snapshot => {
    if (snapshot.phase !== "running" || sent) return;
    submittedBeforeCreateSettled = !createSettled;
    sent = f.host.submit({ scope, id: "first-send-from-running", generation: snapshot.generation, command: { type: "send", text: "first intentional send" } });
  });
  try {
    const creating = f.create(); void creating.then(() => { createSettled = true; });
    await owned.promise; assert.equal((await f.host.snapshot(scope)).phase, "starting");
    assert.equal((await f.submit({ type: "answer", interactionId: "initial-question", choice: "submit", value: { answer: "ready" } })).state, "acknowledged");
    port.invokeGate = sendResult.promise; initialized.resolve();
    // No timer, polling, or browser wait hides the readiness boundary. A refused
    // first Send fails immediately; a real dispatch owns the deferred result.
    await Promise.race([nativeSend.promise, creating.then(async () => { assert.ok(sent); assert.equal((await sent).state, "acknowledged"); })]);
    assert.equal(submittedBeforeCreateSettled, true); assert.equal((await creating).state, "acknowledged");
    assert.equal(port.calls.filter(command => command.type === "send").length, 1);
    // Old Create completion must not clear the new Send's normal owner.
    assert.equal((await f.submit({ type: "send", text: "competing send" })).reason, "busy");
    sendResult.resolve({ status: "applied" }); assert.equal((await sent!).state, "acknowledged");
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { unsubscribe(); initialized.resolve(); sendResult.resolve({ status: "applied" }); await f.dispose(); }
});

test("Host validated Send releases native admission before its receipt listener submits next Send; old finalizer cannot release replacement", async () => {
  const nextNative = defer<void>(), nextResult = defer<NativeOutcome>();
  class ReceiptPort extends ScriptedPort {
    override handle(run?: RunRef): NativeRun {
      const handle = super.handle(run);
      return { ...handle, invoke: command => {
        if (command.type !== "send") return handle.invoke(command);
        this.calls.push(command);
        if (command.text === "second original") { nextNative.resolve(); return nextResult.promise; }
        return Promise.resolve({ status: "applied" });
      } };
    }
  }
  const port = new ReceiptPort(), f = await fixture(port);
  let next: ReturnType<typeof f.host.submit> | undefined, firstSettled = false, beforeFirstSettled = false;
  const unsubscribe = f.host.subscribeReceipt(scope, "first-original", receipt => {
    if (receipt.state !== "acknowledged" || next) return;
    beforeFirstSettled = !firstSettled;
    next = f.host.submit({ scope, id: "second-original", generation: receipt.generation, command: { type: "send", text: "second original" } });
  });
  try {
    await f.create();
    const first = f.host.submit({ scope, id: "first-original", generation: 1, command: { type: "send", text: "first original" } });
    void first.then(() => { firstSettled = true; });
    await Promise.race([nextNative.promise, first.then(async () => { assert.ok(next); assert.equal((await next).state, "acknowledged"); })]);
    assert.equal(beforeFirstSettled, true); assert.equal((await first).state, "acknowledged"); assert.equal(port.calls.length, 2);
    assert.equal((await f.submit({ type: "send", text: "competing third original" })).reason, "busy");
    nextResult.resolve({ status: "applied" }); assert.equal((await next!).state, "acknowledged");
    assert.equal(port.calls.length, 2); await f.submit({ type: "stop" }); await f.host.close();
  } finally { unsubscribe(); nextResult.resolve({ status: "applied" }); await f.dispose(); }
});

test("Host port without optional early ownership accepts Send synchronously from first Running publication", async () => {
  const nativeSend = defer<void>(), sendResult = defer<NativeOutcome>();
  class FinalOnlyPort extends ScriptedPort {
    override handle(run?: RunRef): NativeRun {
      const handle = super.handle(run);
      return { ...handle, invoke: command => { const result = handle.invoke(command); if (command.type === "send") nativeSend.resolve(); return result; } };
    }
  }
  const port = new FinalOnlyPort(); port.invokeGate = sendResult.promise;
  const f = await fixture(port); let sent: ReturnType<typeof f.host.submit> | undefined, createSettled = false, beforeCreateSettled = false;
  const unsubscribe = f.host.subscribe(scope, snapshot => {
    if (snapshot.phase !== "running" || sent) return;
    assert.equal(snapshot.nativeSession, "native-original"); beforeCreateSettled = !createSettled;
    sent = f.host.submit({ scope, id: "send-after-final-only-open", generation: snapshot.generation, command: { type: "send", text: "first final-only send" } });
  });
  try {
    assert.equal((await f.host.snapshot(scope)).nativeSession, null);
    const creating = f.create(); void creating.then(() => { createSettled = true; });
    await Promise.race([nativeSend.promise, creating.then(async () => { assert.ok(sent); assert.equal((await sent).state, "acknowledged"); })]);
    assert.equal(beforeCreateSettled, true); assert.equal((await creating).state, "acknowledged"); assert.equal(port.calls.length, 1);
    assert.equal((await f.submit({ type: "send", text: "must remain busy" })).reason, "busy");
    sendResult.resolve({ status: "applied" }); assert.equal((await sent!).state, "acknowledged");
    await f.submit({ type: "stop" }); await f.host.close();
  } finally { unsubscribe(); sendResult.resolve({ status: "applied" }); await f.dispose(); }
});

