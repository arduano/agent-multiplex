import {
  AdapterPreparationError, AdapterResumeFailureError, AdapterInputNotSubmittedError,
  type AgentAdapter, type AdapterEvent, type AdapterSession, type AdapterNativeHistoryResult,
} from "@arduano/agent-multiplex-runtime-node-core";
import type { Harness, HarnessSpawnOptions, NativeHistoryRequest, NativeModel, SessionBinding } from "./protocol.js";
import { NativeOperationError } from "./errors.js";

/** The port owns no binding map, recovery loop, catalog, queue or event reducer. */
export interface NativePort {
  readonly harness: Harness;
  readonly adapterScopeId: string;
  readonly inputCapabilities?: AgentAdapter["inputCapabilities"];
  create(options: HarnessSpawnOptions): Promise<AdapterSession>;
  resume(binding: SessionBinding): Promise<AdapterSession>;
  models(): Promise<NativeModel[]>;
  history?(binding: SessionBinding, request: NativeHistoryRequest): Promise<AdapterNativeHistoryResult>;
  release?(binding: SessionBinding): Promise<void>;
  /** Release native ownership and settle outstanding calls to that owner. */
  close(): Promise<void>;
}
function normalize(error: unknown): never {
  if (error instanceof AdapterPreparationError || error instanceof AdapterResumeFailureError) {
    throw new NativeOperationError("NATIVE_REJECTED", error.message, "failed", { cause: error });
  }
  throw error;
}
function normalizeInput(error: unknown): never {
  if (error instanceof AdapterInputNotSubmittedError)
    throw new NativeOperationError(`INPUT_NOT_SUBMITTED_${error.reason}`, "Native input was not submitted", "failed", { cause: error });
  throw error;
}
function inputBoundary(session: AdapterSession): AdapterSession {
  // Preserve all optional native capabilities and callback ownership. A Proxy
  // forwards methods with their original private-field receiver.
  return new Proxy(session, { get(target, key) {
    if (key === "execute") return (command: Parameters<AdapterSession["execute"]>[0], context?: { requestId: string }) => target.execute(command, context).catch(normalizeInput);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
export function nativePortForAdapter(adapter: AgentAdapter): NativePort {
  return {
    harness: adapter.harness, adapterScopeId: adapter.adapterScopeId,
    ...(adapter.inputCapabilities ? { inputCapabilities: adapter.inputCapabilities } : {}),
    create: options => adapter.spawn(options).then(inputBoundary).catch(normalize),
    resume: binding => adapter.resume(adapter.harness === "copilot"
      ? { harness: "copilot", vendorSessionId: binding.vendorSessionId,
        ...(binding.cwd === null ? {} : { cwd: binding.cwd }), continuePendingWork: false }
      : { harness: "codex", vendorSessionId: binding.vendorSessionId,
        ...(binding.cwd === null ? {} : { cwd: binding.cwd }) }).then(inputBoundary).catch(normalize),
    models: () => adapter.listModels(), close: () => adapter.close(),
    // Existing adapter release takes a V6 runtime catalog record; do not create
    // a fake one. Stop certifies local controller release while native histories
    // stay owned by the app server. V7 archive marks only its binding archived.
  };
}
export type { AdapterEvent, AdapterSession };
