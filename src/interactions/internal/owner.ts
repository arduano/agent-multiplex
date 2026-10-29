import type { InteractionOptions } from "../contracts.js";
import type { Original, RunRef } from "../../protocol/index.js";
import type {
  Answer,
  CapabilityRef,
  Capture,
  Interaction,
  InteractionSnapshot,
  StopConfirmation,
} from "../contracts.js";
import { validateAnswer, validatePrompt } from "./forms.js";
import { binding, check, delivery, frozen, id, json, original, originalKey } from "./validation.js";

type Entry = {
  view: Interaction;
  blocked: boolean;
  reply?: (answer: Answer) => Promise<import("../contracts.js").Delivery>;
  submission?: Promise<Interaction>;
  answer?: string;
};
/** Exact callback custody, not an effect journal. dispatch is called only by
 * the existing lifecycle original AFTER durable admission. Observer detach,
 * disconnect and returned writes never synthesize a native response. */
export class InteractionOwner {
  readonly #run: RunRef;
  readonly #attachment: string;
  readonly #limits: Required<InteractionOptions>;
  readonly #entries = new Map<number, Entry>();
  readonly #tokens = new WeakMap<object, Entry>();
  readonly #listeners = new Set<(snapshot: InteractionSnapshot) => void>();
  #snapshot: InteractionSnapshot;
  #serial = 0;
  #stopped = false;
  constructor(run: RunRef, attachment: string, options: InteractionOptions = {}) {
    binding(run, attachment, run, attachment);
    this.#run = frozen(run);
    this.#attachment = attachment;
    this.#limits = {
      baseline: "partial",
      maxPending: 128,
      maxRecent: 32,
      maxListeners: 64,
      ...options,
    };
    check(["complete", "partial"].includes(this.#limits.baseline));
    for (const value of [
      this.#limits.maxPending,
      this.#limits.maxRecent,
      this.#limits.maxListeners,
    ])
      check(Number.isSafeInteger(value) && value > 0 && value <= 1024);
    this.#snapshot = frozen({
      run: this.#run,
      attachment,
      revision: 0,
      baseline: this.#limits.baseline,
      issue: null,
      items: [],
    });
  }
  getSnapshot(): InteractionSnapshot {
    return this.#snapshot;
  }
  subscribe(listener: (snapshot: InteractionSnapshot) => void): () => void {
    check(this.#listeners.size < this.#limits.maxListeners, "FULL");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  capture<P extends import("../contracts.js").Prompt>(input: Capture<P>): CapabilityRef {
    binding(input.run, input.attachment, this.#run, this.#attachment);
    check(!this.#stopped, "FENCED");
    id(input.owner.nativeAgent);
    check(input.owner.relation === "root" || input.owner.relation === "child");
    check(
      input.owner.relation === "root"
        ? input.owner.nativeAgent === this.#run.nativeSession
        : input.owner.nativeAgent !== this.#run.nativeSession,
      "FENCED",
    );
    check(
      input.capability !== null &&
        typeof input.capability === "object" &&
        typeof input.reply === "function",
    );
    if (input.nativeRequestId !== null) id(input.nativeRequestId);
    const prompt = validatePrompt(input.prompt),
      previous = this.#tokens.get(input.capability);
    if (previous) {
      check(this.#entries.get(previous.view.reference.incarnation) === previous, "FENCED");
      check(
        json(previous.view.prompt) === json(prompt) &&
          previous.view.nativeRequestId === input.nativeRequestId &&
          json(previous.view.owner) === json(input.owner),
        "CONFLICT",
      );
      return previous.view.reference;
    }
    if (
      [...this.#entries.values()].filter((entry) => !this.#terminal(entry)).length >=
      this.#limits.maxPending
    ) {
      this.#publish("capacity");
      check(false, "FULL");
    }
    const reference = frozen({
      run: this.#run,
      attachment: this.#attachment,
      incarnation: ++this.#serial,
    });
    check(Number.isSafeInteger(this.#serial), "FULL");
    const overlapping =
      input.nativeRequestId === null
        ? []
        : [...this.#entries.values()].filter(
            (entry) =>
              !this.#terminal(entry) &&
              entry.view.nativeRequestId === input.nativeRequestId &&
              entry.view.owner.nativeAgent === input.owner.nativeAgent,
          );
    const entry: Entry = {
      blocked: overlapping.length > 0,
      reply: input.reply as (answer: Answer) => Promise<import("../contracts.js").Delivery>,
      view: frozen({
        reference,
        owner: input.owner,
        nativeRequestId: input.nativeRequestId,
        prompt,
        state: "pending",
        original: null,
        accepted: null,
        issue: overlapping.length ? "idReuse" : null,
      }),
    };
    for (const older of overlapping) {
      older.blocked = true;
      older.view = frozen({ ...older.view, issue: "idReuse" });
    }
    this.#entries.set(reference.incarnation, entry);
    this.#tokens.set(input.capability, entry);
    this.#publish(overlapping.length ? "idReuse" : undefined);
    return reference;
  }
  /** The exact durable original owns response dispatch and reconciliation.
   * This structural owner validates its identity; it does not claim to persist it. */
  dispatch(reference: CapabilityRef, admitted: Original, answer: Answer): Promise<Interaction> {
    const entry = this.#entry(reference);
    original(admitted, this.#run);
    const value = validateAnswer(entry.view.prompt, answer),
      encoded = json(value, 16384);
    if (entry.submission) {
      check(
        entry.view.original &&
          json(entry.view.original) === json(admitted) &&
          entry.answer === encoded,
        "CONFLICT",
      );
      return entry.submission;
    }
    check(
      !this.#stopped && !entry.blocked && entry.view.state === "pending" && entry.reply,
      "FENCED",
    );
    check(
      ![...this.#entries.values()].some(
        (other) =>
          other !== entry &&
          other.view.original &&
          originalKey(other.view.original) === originalKey(admitted),
      ),
      "CONFLICT",
    );
    entry.answer = encoded;
    entry.view = frozen({ ...entry.view, original: admitted, state: "submitting" });
    const reply = entry.reply;
    entry.submission = Promise.resolve().then(async () => {
      // A positive Stop that wins before dispatch cannot invoke an old callback.
      if (this.#stopped || entry.blocked) return entry.view;
      try {
        const result = await reply(value);
        delivery(result);
        if (!this.#terminal(entry)) {
          if (result.kind === "confirmed") this.#confirm(entry, result.accepted);
          else {
            entry.view = frozen({ ...entry.view, state: "submitted" });
            this.#publish();
          }
        }
      } catch {
        if (!this.#terminal(entry)) {
          entry.view = frozen({ ...entry.view, state: "unknown", issue: "deliveryUnknown" });
          this.#publish();
        }
      }
      return entry.view;
    });
    this.#publish();
    return entry.submission;
  }
  confirm(run: RunRef, attachment: string, capability: object, accepted: boolean): void {
    binding(run, attachment, this.#run, this.#attachment);
    check(typeof accepted === "boolean");
    const entry = this.#tokens.get(capability);
    check(entry && this.#entries.get(entry.view.reference.incarnation) === entry, "FENCED");
    if (this.#terminal(entry)) {
      if (entry.view.state === "confirmed") check(entry.view.accepted === accepted, "CONFLICT");
      return;
    }
    this.#confirm(entry, accepted);
  }
  #confirm(entry: Entry, accepted: boolean): void {
    entry.view = frozen({ ...entry.view, state: "confirmed", accepted });
    delete entry.reply;
    this.#publish();
  }
  disconnected(): void {
    if (this.#stopped) return;
    for (const entry of this.#entries.values())
      if (!this.#terminal(entry)) entry.view = frozen({ ...entry.view, issue: "disconnected" });
    this.#publish("nativeGap");
  }
  nativeGap(): void {
    if (!this.#stopped) this.#publish("nativeGap");
  }
  confirmedStopped(proof: StopConfirmation): void {
    binding(proof.run, proof.attachment, this.#run, this.#attachment);
    check(proof.confirmed === true);
    if (this.#stopped) return;
    this.#stopped = true;
    for (const entry of this.#entries.values())
      if (!this.#terminal(entry)) {
        entry.view = frozen({ ...entry.view, state: "retired" });
        delete entry.reply;
      }
    this.#publish("stopped");
  }
  #entry(reference: CapabilityRef): Entry {
    binding(reference.run, reference.attachment, this.#run, this.#attachment);
    check(Number.isSafeInteger(reference.incarnation) && reference.incarnation > 0);
    const entry = this.#entries.get(reference.incarnation);
    check(entry, "FENCED");
    return entry;
  }
  #terminal(entry: Entry): boolean {
    return entry.view.state === "confirmed" || entry.view.state === "retired";
  }
  #publish(issue?: InteractionSnapshot["issue"]): void {
    const settled = [...this.#entries.values()].filter((entry) => this.#terminal(entry));
    for (const entry of settled.slice(0, Math.max(0, settled.length - this.#limits.maxRecent)))
      this.#entries.delete(entry.view.reference.incarnation);
    this.#snapshot = frozen({
      ...this.#snapshot,
      revision: this.#snapshot.revision + 1,
      baseline: issue ? "partial" : this.#snapshot.baseline,
      issue: issue ?? this.#snapshot.issue,
      items: [...this.#entries.values()].map((entry) => entry.view),
    });
    for (const listener of [...this.#listeners])
      try {
        listener(this.#snapshot);
      } catch {
        /* A viewer has no callback custody. */
      }
  }
}
