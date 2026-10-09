import {
  AdapterPreparationError, AdapterResumeFailureError,
  type AgentAdapter, type AdapterEvent, type AdapterSession,
} from "@arduano/agent-multiplex-runtime-node-core";
import type { Harness, HarnessSpawnOptions, NativeModel, SessionBinding } from "./protocol.js";
import { NativeOperationError } from "./errors.js";

/** The port owns no binding map, recovery loop, catalog, queue or event reducer. */
export interface NativePort {
  readonly harness: Harness;
  readonly adapterScopeId: string;
  create(options: HarnessSpawnOptions): Promise<AdapterSession>;
  resume(binding: SessionBinding): Promise<AdapterSession>;
  models(): Promise<NativeModel[]>;
  release?(binding: SessionBinding): Promise<void>;
  close(): Promise<void>;
}
function normalize(error: unknown): never {
  if (error instanceof AdapterPreparationError || error instanceof AdapterResumeFailureError) {
    throw new NativeOperationError("NATIVE_REJECTED", error.message, "failed", { cause: error });
  }
  throw error;
}
export function nativePortForAdapter(adapter: AgentAdapter): NativePort {
  return {
    harness: adapter.harness, adapterScopeId: adapter.adapterScopeId,
    create: options => adapter.spawn(options).catch(normalize),
    resume: binding => adapter.resume(adapter.harness === "copilot"
      ? { harness: "copilot", vendorSessionId: binding.vendorSessionId,
        ...(binding.cwd === null ? {} : { cwd: binding.cwd }), continuePendingWork: false }
      : { harness: "codex", vendorSessionId: binding.vendorSessionId,
        ...(binding.cwd === null ? {} : { cwd: binding.cwd }) }).catch(normalize),
    models: () => adapter.listModels(), close: () => adapter.close(),
    // Existing adapter release takes a V6 runtime catalog record; do not create
    // a fake one. Stop certifies local controller release while native histories
    // stay owned by the app server. V7 archive marks only its binding archived.
  };
}
export type { AdapterEvent, AdapterSession };
