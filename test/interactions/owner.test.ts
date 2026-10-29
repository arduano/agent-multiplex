import assert from "node:assert/strict";
import { test } from "node:test";
import {
  InteractionOwner,
  type CallbackSink,
  type Delivery,
} from "../../src/interactions/index.js";
import { admitted, answer, attachment, deferred, question, run } from "./fixture.js";

test("one retained callback dispatches once; submission is weaker than positive native settlement", async () => {
  const owner = new InteractionOwner(run, attachment, { baseline: "complete" });
  const sink: CallbackSink = owner;
  let replies = 0;
  const token = {},
    write = deferred<Delivery>();
  const capture = {
    run,
    attachment,
    owner: { nativeAgent: run.nativeSession, relation: "root" as const },
    nativeRequestId: "request",
    capability: token,
    prompt: question,
    reply: async () => {
      replies++;
      return write.promise;
    },
  };
  const reference = sink.capture(capture);
  assert.deepEqual(sink.capture(capture), reference);
  assert.equal(replies, 0);
  const first = owner.dispatch(reference, admitted("answer"), answer),
    second = owner.dispatch(reference, admitted("answer"), answer);
  assert.equal(first, second);
  const detach = owner.subscribe(() => {
    throw new Error("viewer failed");
  });
  detach();
  await Promise.resolve();
  assert.equal(replies, 1);
  assert.equal(owner.getSnapshot().items[0]!.state, "submitting");
  write.resolve({ kind: "submitted" });
  assert.equal((await first).state, "submitted");
  assert.equal(owner.getSnapshot().items[0]!.accepted, null);
  sink.confirm(run, attachment, token, true);
  assert.equal(owner.getSnapshot().items[0]!.state, "confirmed");
  assert.equal(owner.getSnapshot().items[0]!.accepted, true);
  assert.equal(await owner.dispatch(reference, admitted("answer"), answer), await first);
  assert.throws(() => owner.dispatch(reference, admitted("different"), answer), /CONFLICT/);
  assert.throws(
    () =>
      owner.dispatch(reference, admitted("answer"), {
        ...answer,
        answers: { one: { values: ["No"] } },
      }),
    /CONFLICT/,
  );
  assert(!JSON.stringify(owner.getSnapshot()).includes("capability"));
  assert(Object.isFrozen(owner.getSnapshot().items[0]!.prompt));
});

test("overlapping vendor ID reuse fences both incarnations without denying either native callback", async () => {
  const owner = new InteractionOwner(run, attachment, { baseline: "complete" });
  let replies = 0;
  const capture = (capability: object) =>
    owner.capture({
      run,
      attachment,
      owner: { nativeAgent: run.nativeSession, relation: "root" },
      nativeRequestId: "reused",
      capability,
      prompt: question,
      reply: async () => {
        replies++;
        return { kind: "submitted" };
      },
    });
  const first = capture({}),
    second = capture({});
  assert.notDeepEqual(first, second);
  assert.equal(owner.getSnapshot().baseline, "partial");
  assert.equal(owner.getSnapshot().issue, "idReuse");
  assert.throws(() => owner.dispatch(first, admitted("first"), answer), /FENCED/);
  assert.throws(() => owner.dispatch(second, admitted("second"), answer), /FENCED/);
  assert.equal(replies, 0);
});

test("disconnect and viewer loss retain exact callbacks; only matching positive Stop retires them", async () => {
  const owner = new InteractionOwner(run, attachment, { baseline: "complete" });
  const token = {};
  let replies = 0;
  const ref = owner.capture({
    run,
    attachment,
    owner: { nativeAgent: "proved-child", relation: "child" },
    nativeRequestId: null,
    capability: token,
    prompt: question,
    reply: async () => {
      replies++;
      return { kind: "submitted" };
    },
  });
  const detach = owner.subscribe(() => {});
  detach();
  owner.disconnected();
  assert.equal(owner.getSnapshot().items[0]!.state, "pending");
  assert.equal((await owner.dispatch(ref, admitted("answer"), answer)).state, "submitted");
  assert.equal(replies, 1);
  assert.throws(() => owner.confirm({ ...run, generation: 2 }, attachment, token, true), /FENCED/);
  assert.throws(
    () => owner.confirmedStopped({ run, attachment: "other", confirmed: true }),
    /FENCED/,
  );
  owner.confirmedStopped({ run, attachment, confirmed: true });
  assert.equal(owner.getSnapshot().items[0]!.state, "retired");
  owner.confirm(run, attachment, token, true);
  assert.equal(owner.getSnapshot().items[0]!.state, "retired");
  assert.equal(replies, 1);
});

test("unknown replies remain protected through pressure; terminal activity rolls without a lifetime admission cap", async () => {
  const owner = new InteractionOwner(run, attachment, {
    baseline: "complete",
    maxPending: 1,
    maxRecent: 2,
  });
  const capture = (capability: object, request: string, reply: () => Promise<Delivery>) =>
    owner.capture({
      run,
      attachment,
      owner: { nativeAgent: run.nativeSession, relation: "root" },
      nativeRequestId: request,
      capability,
      prompt: question,
      reply,
    });
  const token = {},
    unknown = capture(token, "unknown", async () => {
      throw new Error("private transport reason");
    });
  assert.equal((await owner.dispatch(unknown, admitted("unknown"), answer)).state, "unknown");
  assert.throws(() => capture({}, "new", async () => ({ kind: "submitted" })), /FULL/);
  assert.equal(owner.getSnapshot().items[0]!.reference.incarnation, unknown.incarnation);
  owner.confirm(run, attachment, token, false);
  for (let index = 0; index < 40; index++) {
    const ref = capture({}, `request-${index}`, async () => ({
      kind: "confirmed",
      accepted: true,
    }));
    await owner.dispatch(ref, admitted(`answer-${index}`), answer);
  }
  assert.equal(owner.getSnapshot().items.length, 2);
  assert.throws(() => owner.dispatch(unknown, admitted("unknown"), answer), /FENCED/);
  assert(!JSON.stringify(owner.getSnapshot()).includes("private transport reason"));
});

test("early exact settlement wins over a later failing write; invalid answers never dispatch", async () => {
  const owner = new InteractionOwner(run, attachment);
  const token = {},
    pending = deferred<Delivery>();
  let replies = 0;
  const ref = owner.capture({
    run,
    attachment,
    owner: { nativeAgent: run.nativeSession, relation: "root" },
    nativeRequestId: "one",
    capability: token,
    prompt: question,
    reply: async () => {
      replies++;
      return pending.promise;
    },
  });
  assert.throws(
    () => owner.dispatch(ref, admitted("bad"), { type: "codex.question", answers: {} }),
    /INVALID/,
  );
  assert.equal(replies, 0);
  const submission = owner.dispatch(ref, admitted("valid"), answer);
  await Promise.resolve();
  owner.confirm(run, attachment, token, true);
  pending.reject(new Error("late lost write"));
  assert.equal((await submission).state, "confirmed");
  assert.equal(owner.getSnapshot().items[0]!.accepted, true);
  assert.throws(() => owner.confirm(run, attachment, token, false), /CONFLICT/);
});
