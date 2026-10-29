import type { McpHandle, McpOptions } from "../contracts.js";
import type { Json, Original, RunRef } from "../../protocol/index.js";
import type {
  McpManagementPort,
  McpOperation,
  McpServer,
  PrivateMcpServer,
  StopConfirmation,
} from "../contracts.js";
import {
  binding,
  check,
  delivery,
  frozen,
  id,
  json,
  keys,
  object,
  observe,
  original,
  originalKey,
  strings,
  text,
} from "./validation.js";

/** Only this allowlisted projection may cross a public boundary. Even URL
 * origins, executable paths and hashes of private configuration stay private. */
export function publicMcpServers(definitions: readonly PrivateMcpServer[]): readonly McpServer[] {
  json(definitions, 262144);
  check(Array.isArray(definitions) && definitions.length <= 64);
  const result = definitions.map((value) => {
    keys(object(value), ["name", "enabled", "tools", "transport"]);
    id(value.name);
    check(typeof value.enabled === "boolean");
    if (value.tools !== "enabled" && value.tools !== "disabled") strings(value.tools, 128);
    const transport = value.transport;
    const raw = object(transport);
    if (transport.type === "stdio") {
      keys(raw, ["type", "command", "args", "env", "cwd"]);
      text(transport.command, 4096);
      check(transport.command.length > 0);
      check(Array.isArray(transport.args) && transport.args.length <= 128);
      for (const argument of transport.args) text(argument, 4096);
      for (const [key, value] of Object.entries(object(transport.env))) {
        id(key);
        text(value);
      }
      if (transport.cwd !== undefined) text(transport.cwd, 4096);
    } else {
      check(transport.type === "http");
      keys(raw, ["type", "url", "headers"]);
      let url: URL;
      try {
        url = new URL(transport.url);
      } catch {
        check(false);
      }
      check(["http:", "https:"].includes(url.protocol));
      for (const [key, value] of Object.entries(object(transport.headers))) {
        id(key);
        text(value);
      }
    }
    return {
      name: value.name,
      enabled: value.enabled,
      transport: transport.type,
      tools: value.tools,
      serverConfirmations: "surface" as const,
    };
  });
  check(new Set(result.map((value) => value.name)).size === result.length);
  return frozen(result);
}
type Job = {
  view: McpOperation;
  meaning: string;
  actual: boolean;
  submitted: Promise<McpOperation>;
  handle: McpHandle;
};
/** Retains the distinct native login/reload resource. It is not another journal:
 * dispatch runs only for a fresh durably admitted original from lifecycle. */
export class McpOwner<Reload extends Json, Login extends Json> {
  readonly #run: RunRef;
  readonly #attachment: string;
  readonly #adapter: McpManagementPort<Reload, Login>;
  readonly #limits: Required<McpOptions>;
  readonly #jobs = new Map<string, Job>();
  readonly #listeners = new Set<() => void>();
  #stopped = false;
  constructor(
    run: RunRef,
    attachment: string,
    adapter: McpManagementPort<Reload, Login>,
    options: McpOptions = {},
  ) {
    binding(run, attachment, run, attachment);
    id(adapter.adapter);
    this.#run = frozen(run);
    this.#attachment = attachment;
    this.#adapter = Object.freeze({
      adapter: adapter.adapter,
      ...(adapter.reload ? { reload: adapter.reload.bind(adapter) } : {}),
      ...(adapter.login ? { login: adapter.login.bind(adapter) } : {}),
    });
    this.#limits = { maxPending: 8, maxRecent: 32, maxListeners: 64, ...options };
    for (const value of Object.values(this.#limits))
      check(Number.isSafeInteger(value) && value > 0 && value <= 1024);
  }
  get actualCount(): number {
    return [...this.#jobs.values()].filter((job) => job.actual).length;
  }
  getSnapshot(): readonly McpOperation[] {
    return frozen([...this.#jobs.values()].map((job) => job.view));
  }
  subscribe(listener: () => void): () => void {
    check(this.#listeners.size < this.#limits.maxListeners, "FULL");
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  reload(admitted: Original, input: Reload): McpHandle {
    check(this.#adapter.reload, "UNSUPPORTED");
    return this.#dispatch("reload", admitted, input, (input, context) =>
      this.#adapter.reload!(input as Reload, context),
    );
  }
  login(admitted: Original, input: Login): McpHandle {
    check(this.#adapter.login, "UNSUPPORTED");
    return this.#dispatch("login", admitted, input, (input, context) =>
      this.#adapter.login!(input as Login, context),
    );
  }
  #dispatch(
    kind: "reload" | "login",
    admitted: Original,
    input: Json,
    invoke: (
      input: Json,
      context: import("../contracts.js").McpContext,
    ) => Promise<import("../contracts.js").Delivery>,
  ): McpHandle {
    original(admitted, this.#run);
    const key = originalKey(admitted),
      meaning = json({ kind, input });
    const old = this.#jobs.get(key);
    if (old) {
      check(json(old.view.original) === json(admitted) && old.meaning === meaning, "CONFLICT");
      return old.handle;
    }
    check(!this.#stopped, "FENCED");
    check(
      [...this.#jobs.values()].filter((job) => job.actual || !this.#terminal(job)).length <
        this.#limits.maxPending,
      "FULL",
    );
    const value = frozen(input),
      context = frozen({ run: this.#run, attachment: this.#attachment, original: admitted });
    const job = {} as Job;
    job.view = frozen({ original: admitted, kind, state: "running", accepted: null });
    job.meaning = meaning;
    job.actual = true;
    job.handle = Object.freeze({
      getSnapshot: () => job.view,
      observe: (timeoutMs: number, signal?: AbortSignal) =>
        observe(job.submitted, timeoutMs, signal),
    });
    job.submitted = Promise.resolve().then(async () => {
      try {
        if (this.#stopped) return job.view;
        const result = await invoke(value, context);
        delivery(result);
        if (!this.#terminal(job))
          job.view = frozen({
            ...job.view,
            state: result.kind === "confirmed" ? "confirmed" : "submitted",
            accepted: result.kind === "confirmed" ? result.accepted : null,
          });
      } catch {
        if (!this.#terminal(job)) job.view = frozen({ ...job.view, state: "unknown" });
      } finally {
        job.actual = false;
        this.#publish();
      }
      return job.view;
    });
    this.#jobs.set(key, job);
    this.#publish();
    return job.handle;
  }
  confirm(run: RunRef, attachment: string, admitted: Original, accepted: boolean): void {
    binding(run, attachment, this.#run, this.#attachment);
    original(admitted, this.#run);
    check(typeof accepted === "boolean");
    const job = this.#jobs.get(originalKey(admitted));
    check(job && json(job.view.original) === json(admitted), "FENCED");
    if (this.#terminal(job)) {
      if (job.view.state === "confirmed") check(job.view.accepted === accepted, "CONFLICT");
      return;
    }
    job.view = frozen({ ...job.view, state: "confirmed", accepted });
    this.#publish();
  }
  confirmedStopped(proof: StopConfirmation): void {
    binding(proof.run, proof.attachment, this.#run, this.#attachment);
    check(proof.confirmed === true);
    this.#stopped = true;
    for (const job of this.#jobs.values())
      if (!this.#terminal(job)) job.view = frozen({ ...job.view, state: "retired" });
    this.#publish();
  }
  #terminal(job: Job): boolean {
    return job.view.state === "confirmed" || job.view.state === "retired";
  }
  #publish(): void {
    const settled = [...this.#jobs.entries()].filter(
      ([, job]) => !job.actual && this.#terminal(job),
    );
    for (const [key] of settled.slice(0, Math.max(0, settled.length - this.#limits.maxRecent)))
      this.#jobs.delete(key);
    for (const listener of [...this.#listeners])
      try {
        listener();
      } catch {
        /* A viewer cannot cancel an admitted management operation. */
      }
  }
}
