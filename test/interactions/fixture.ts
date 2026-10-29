import type { Original, RunRef } from "../../src/protocol/index.js";
import type { Prompt } from "../../src/interactions/index.js";

export const run: RunRef = {
  scope: { connection: "connection", principal: "principal", host: "host", session: "session" },
  generation: 1,
  nativeSession: "native-root",
};
export const attachment = "capture-1";
export const admitted = (id: string): Original => ({
  scope: run.scope,
  id,
  requestHash: "a".repeat(64),
});
export const question: Extract<Prompt, { type: "codex.question" }> = {
  type: "codex.question",
  title: "Questions",
  blocking: true,
  questions: [
    {
      id: "one",
      header: "Header",
      question: "Choose",
      secret: false,
      other: false,
      options: [{ label: "Yes", description: "Keep this exact label" }, { label: "No" }],
    },
  ],
};
export const answer = { type: "codex.question", answers: { one: { values: ["Yes"] } } } as const;
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
