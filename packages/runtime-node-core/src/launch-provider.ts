import { createHash } from "node:crypto";

import {
  canonicalJson,
  harnessSpawnOptionsSchema,
  jsonObjectSchema,
  launchProfileDescriptorSchema,
  toJsonValue,
  type AdapterScopeId,
  type Harness,
  type HarnessResumeOptions,
  type HarnessSpawnOptions,
  type JsonObject,
  type LaunchBackendId,
  type LaunchProfileDescriptor,
  type LaunchRequest,
  type NativeModel,
  type RuntimeNodeSessionRecord,
} from "@arduano/agent-multiplex-protocol";

import type { RuntimeAgentBackend } from "./adapter.js";

/** Durable provider output written before the first native spawn attempt. */
export interface RuntimePreparedLaunch {
  readonly backendId: LaunchBackendId;
  readonly spawnOptions: HarnessSpawnOptions;
  /** Provider-private recovery data. It is never projected into a session. */
  readonly providerState?: JsonObject;
}

interface ProviderCheckpointContext {
  /** Last provider-private durable checkpoint, never sent to a client. */
  readonly checkpoint: JsonObject | null;
  /** Persist at every provider-owned external-effect boundary. */
  saveCheckpoint(checkpoint: JsonObject): void;
  /** Resolve a statically registered native backend by opaque identity. */
  backend(backendId: LaunchBackendId): RuntimeAgentBackend;
}

export interface LaunchPreparationContext extends ProviderCheckpointContext {
  readonly request: LaunchRequest;
  /** Present while compensating or recovering a durably prepared launch. */
  readonly prepared: RuntimePreparedLaunch | null;
}

export type LaunchRecoveryResult =
  | { readonly state: "retryPreparation" }
  | { readonly state: "prepared"; readonly prepared: RuntimePreparedLaunch }
  | { readonly state: "outcomeUnknown"; readonly reason: string };

export interface LaunchSessionContext extends ProviderCheckpointContext {
  readonly session: RuntimeNodeSessionRecord;
  /** The original durable provider result for this session. */
  readonly prepared: RuntimePreparedLaunch;
}

export interface LaunchResumeContext extends LaunchSessionContext {
  readonly purpose: "interactive" | "history";
  readonly defaults: HarnessResumeOptions;
}

export interface RuntimePreparedResume {
  readonly backendId: LaunchBackendId;
  readonly resumeOptions: HarnessResumeOptions;
}

/**
 * Trusted, statically composed runtime extension. Providers own domain input,
 * placement, and exclusive-resource lifecycle. Backends own harness-native
 * sessions. Credentials belong in provider/backend configuration, never input.
 */
export interface RuntimeLaunchProvider {
  readonly descriptor: LaunchProfileDescriptor;
  /** Canonical JSON Schema fenced by descriptor.requestSchemaHash. */
  readonly requestSchema: JsonObject;

  /** Runtime-side admission remains mandatory even when a gateway validates. */
  validateInput(input: JsonObject, harness: Harness): JsonObject;
  listModels?(
    harness: Harness,
    context: Pick<LaunchPreparationContext, "backend">,
  ): Promise<NativeModel[]>;
  prepare(context: LaunchPreparationContext): Promise<RuntimePreparedLaunch>;
  /** Core invokes this after a crash in `preparing`; it never blindly retries. */
  recoverPreparation(context: LaunchPreparationContext): Promise<LaunchRecoveryResult>;
  /** Compensate a definite pre-bind failure. This operation must be idempotent. */
  compensate(context: LaunchPreparationContext, cause: unknown): Promise<void>;
  /** Re-establish provider resources before native resume/history attachment. */
  prepareResume?(context: LaunchResumeContext): Promise<RuntimePreparedResume>;
  /** Optional resumability-preserving provider work after the native handle stops. */
  stop?(context: LaunchSessionContext): Promise<void>;
  /** Release session-exclusive provider resources. This must be idempotent. */
  release(context: LaunchSessionContext): Promise<void>;
  close?(): Promise<void>;
}

/** Signals an ambiguous provider effect that core must never retry or undo. */
export class LaunchProviderOutcomeUnknownError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LaunchProviderOutcomeUnknownError";
  }
}

export class LaunchProviderError extends Error {
  public constructor(
    public readonly code: "CONFLICT" | "FENCED" | "UNSUPPORTED",
    message: string,
  ) {
    super(message);
    this.name = "LaunchProviderError";
  }
}

export class LaunchProviderRegistry {
  readonly #providers = new Map<string, RuntimeLaunchProvider>();
  readonly #backends = new Map<LaunchBackendId, RuntimeAgentBackend>();
  readonly #nativeBackends = new Map<string, LaunchBackendId>();

  public constructor(
    providers: readonly RuntimeLaunchProvider[],
    backends: readonly RuntimeAgentBackend[],
  ) {
    for (const backend of backends) this.#registerBackend(backend);
    for (const provider of providers) this.#registerProvider(provider);
  }

  public descriptors(): LaunchProfileDescriptor[] {
    return [...this.#providers.values()]
      .map((provider) => provider.descriptor)
      .sort((left, right) => profileKey(left).localeCompare(profileKey(right)));
  }

  public provider(profile: LaunchRequest["profile"]): RuntimeLaunchProvider {
    const provider = this.#providers.get(profileKey(profile));
    if (!provider) {
      throw new LaunchProviderError(
        "UNSUPPORTED",
        `launch profile ${profile.providerId}/${profile.profileId} is not registered at contract ${profile.contractVersion}`,
      );
    }
    if (provider.descriptor.requestSchemaHash !== profile.requestSchemaHash) {
      throw new LaunchProviderError(
        "FENCED",
        `launch profile ${profile.providerId}/${profile.profileId} request schema fence changed`,
      );
    }
    return provider;
  }

  public providerForSession(
    session: RuntimeNodeSessionRecord,
  ): RuntimeLaunchProvider | undefined {
    const provenance = session.launchProvenance;
    if (!provenance) return undefined;
    return this.provider(provenance);
  }

  public backend(backendId: LaunchBackendId): RuntimeAgentBackend {
    const backend = this.#backends.get(backendId);
    if (!backend) {
      throw new LaunchProviderError(
        "UNSUPPORTED",
        `agent backend ${backendId} is not registered`,
      );
    }
    return backend;
  }

  public backends(): RuntimeAgentBackend[] {
    return [...this.#backends.values()];
  }

  public backendsForHarness(harness: Harness): RuntimeAgentBackend[] {
    return this.backends().filter((backend) => backend.adapter.harness === harness);
  }

  public backendForNative(
    harness: Harness,
    adapterScopeId: AdapterScopeId,
  ): RuntimeAgentBackend {
    const id = this.#nativeBackends.get(nativeBackendKey(harness, adapterScopeId));
    if (!id) {
      throw new LaunchProviderError(
        "UNSUPPORTED",
        `agent backend ${harness}/${adapterScopeId} is not registered`,
      );
    }
    return this.backend(id);
  }

  public backendForSession(session: RuntimeNodeSessionRecord): RuntimeAgentBackend {
    const provenance = session.launchProvenance;
    const backend = provenance
      ? this.backend(provenance.backendId)
      : this.backendForNative(session.harness, session.adapterScopeId);
    if (
      backend.adapter.harness !== session.harness ||
      backend.adapter.adapterScopeId !== session.adapterScopeId
    ) {
      throw new LaunchProviderError(
        "FENCED",
        `backend ${backend.backendId} no longer matches session ${session.sessionId}`,
      );
    }
    return backend;
  }

  public backendId(harness: Harness, adapterScopeId: AdapterScopeId): LaunchBackendId {
    return this.backendForNative(harness, adapterScopeId).backendId;
  }

  public async closeProviders(): Promise<void> {
    await Promise.all([...this.#providers.values()].map((provider) => provider.close?.()));
  }

  public async closeBackends(): Promise<void> {
    await Promise.all(this.backends().map((backend) => backend.adapter.close()));
  }

  #registerBackend(backend: RuntimeAgentBackend): void {
    if (this.#backends.has(backend.backendId)) {
      throw new TypeError(`duplicate agent backend ID ${backend.backendId}`);
    }
    const nativeKey = nativeBackendKey(
      backend.adapter.harness,
      backend.adapter.adapterScopeId,
    );
    if (this.#nativeBackends.has(nativeKey)) {
      throw new TypeError(
        `duplicate ${backend.adapter.harness} adapter scope ${backend.adapter.adapterScopeId}`,
      );
    }
    this.#backends.set(backend.backendId, backend);
    this.#nativeBackends.set(nativeKey, backend.backendId);
  }

  #registerProvider(provider: RuntimeLaunchProvider): void {
    const descriptor = launchProfileDescriptorSchema.parse(provider.descriptor);
    const actualHash = jsonSchemaSha256(provider.requestSchema);
    if (actualHash !== descriptor.requestSchemaHash) {
      throw new TypeError(
        `launch profile ${descriptor.providerId}/${descriptor.profileId} schema hash mismatch: descriptor=${descriptor.requestSchemaHash}, actual=${actualHash}`,
      );
    }
    const key = profileKey(descriptor);
    if (this.#providers.has(key)) {
      throw new TypeError(
        `duplicate launch profile ${descriptor.providerId}/${descriptor.profileId} contract ${descriptor.contractVersion}`,
      );
    }
    this.#providers.set(key, provider);
  }
}

export const DIRECT_WORKSPACE_PROVIDER_ID = "core.direct" as const;
export const DIRECT_WORKSPACE_PROFILE_ID = "workspace" as const;

/** Public input contract for the built-in no-isolation provider. */
export const DIRECT_WORKSPACE_REQUEST_SCHEMA = Object.freeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  type: "object",
  additionalProperties: true,
  required: ["cwd"],
  properties: {
    cwd: { type: "string", minLength: 1 },
    backendId: { type: "string", minLength: 1 },
  },
}) as JsonObject;

export const jsonSchemaSha256 = (schema: JsonObject): string =>
  createHash("sha256")
    .update(canonicalJson(toJsonValue(schema)))
    .digest("hex");

export interface DirectWorkspaceLaunchProviderOptions {
  readonly backends: readonly RuntimeAgentBackend[];
  readonly profileId?: string;
  readonly implementationVersion?: string;
}

/** Built-in profile matching the former caller-owned absolute-cwd launch. */
export class DirectWorkspaceLaunchProvider implements RuntimeLaunchProvider {
  public readonly requestSchema = DIRECT_WORKSPACE_REQUEST_SCHEMA;
  public readonly descriptor: LaunchProfileDescriptor;
  readonly #backendByHarness = new Map<
    Harness,
    Map<LaunchBackendId, RuntimeAgentBackend>
  >();

  public constructor(options: DirectWorkspaceLaunchProviderOptions) {
    for (const backend of options.backends) {
      const harnessBackends = this.#backendByHarness.get(backend.adapter.harness) ?? new Map();
      if (harnessBackends.has(backend.backendId)) {
        throw new TypeError(`duplicate direct-workspace backend ${backend.backendId}`);
      }
      harnessBackends.set(backend.backendId, backend);
      this.#backendByHarness.set(backend.adapter.harness, harnessBackends);
    }
    const harnesses = [...this.#backendByHarness.keys()].sort();
    if (harnesses.length === 0) {
      throw new TypeError("the direct workspace launch profile requires at least one backend");
    }
    this.descriptor = launchProfileDescriptorSchema.parse({
      profileId: options.profileId ?? DIRECT_WORKSPACE_PROFILE_ID,
      providerId: DIRECT_WORKSPACE_PROVIDER_ID,
      contractVersion: 1,
      requestSchemaHash: jsonSchemaSha256(this.requestSchema),
      implementationVersion: options.implementationVersion ?? "1.0.0",
      harnesses,
      available: true,
      capabilities: [
        { name: "workspace.existing-directory", version: "v1", experimental: false },
        { name: "isolation.none", version: "v1", experimental: false },
      ],
    });
  }

  public validateInput(input: JsonObject, harness: Harness): JsonObject {
    if (!this.#backendByHarness.has(harness)) {
      throw new LaunchProviderError(
        "UNSUPPORTED",
        `direct workspace profile does not support ${harness}`,
      );
    }
    if (input.backendId !== undefined && typeof input.backendId !== "string") {
      throw new TypeError("direct workspace launch input.backendId must be a string");
    }
    const candidate: JsonObject = { ...input, harness };
    delete candidate.backendId;
    harnessSpawnOptionsSchema.parse(candidate);
    return input;
  }

  public async listModels(
    harness: Harness,
    context: Pick<LaunchPreparationContext, "backend">,
  ): Promise<NativeModel[]> {
    const configured = this.#backendByHarness.get(harness);
    if (!configured) return [];
    const results = await Promise.all(
      [...configured.keys()].map((backendId) => context.backend(backendId).adapter.listModels()),
    );
    return deduplicateModels(results.flat());
  }

  public async prepare(context: LaunchPreparationContext): Promise<RuntimePreparedLaunch> {
    const input = this.validateInput(context.request.input, context.request.harness);
    const backendId = this.#selectBackend(
      context.request.harness,
      typeof input.backendId === "string" ? input.backendId : undefined,
    );
    const candidate: JsonObject = { ...input, harness: context.request.harness };
    delete candidate.backendId;
    return {
      backendId,
      spawnOptions: harnessSpawnOptionsSchema.parse(candidate),
    };
  }

  public recoverPreparation(): Promise<LaunchRecoveryResult> {
    // Validation and backend selection have no external effects and are safe to repeat.
    return Promise.resolve({ state: "retryPreparation" });
  }

  public compensate(): Promise<void> {
    return Promise.resolve();
  }

  public prepareResume(context: LaunchResumeContext): Promise<RuntimePreparedResume> {
    return Promise.resolve({
      backendId: context.prepared.backendId,
      resumeOptions: context.defaults,
    });
  }

  public stop(): Promise<void> {
    return Promise.resolve();
  }

  public release(): Promise<void> {
    // Shared app servers and caller-owned workspaces are not session-exclusive.
    return Promise.resolve();
  }

  #selectBackend(harness: Harness, requested: string | undefined): LaunchBackendId {
    const backends = this.#backendByHarness.get(harness);
    if (!backends || backends.size === 0) {
      throw new LaunchProviderError("UNSUPPORTED", `no ${harness} backend is configured`);
    }
    if (requested !== undefined) {
      const id = requested as LaunchBackendId;
      if (!backends.has(id)) {
        throw new LaunchProviderError(
          "UNSUPPORTED",
          `backend ${requested} is not part of this direct ${harness} profile`,
        );
      }
      return id;
    }
    return backends.keys().next().value!;
  }
}

export function defaultBackendId(
  harness: Harness,
  adapterScopeId: AdapterScopeId,
): LaunchBackendId {
  return `${harness}:${adapterScopeId}` as LaunchBackendId;
}

export function nativeResumeOptions(
  session: RuntimeNodeSessionRecord,
): HarnessResumeOptions {
  return session.harness === "copilot"
    ? {
        harness: "copilot",
        vendorSessionId: session.vendorSessionId,
        ...(session.cwd === null ? {} : { cwd: session.cwd }),
        continuePendingWork: false,
      }
    : {
        harness: "codex",
        vendorSessionId: session.vendorSessionId,
        ...(session.cwd === null ? {} : { cwd: session.cwd }),
      };
}

function profileKey(
  profile: Pick<LaunchProfileDescriptor, "providerId" | "profileId" | "contractVersion">,
): string {
  return `${profile.providerId}\0${profile.profileId}\0${profile.contractVersion}`;
}

function nativeBackendKey(harness: Harness, adapterScopeId: AdapterScopeId): string {
  return `${harness}\0${adapterScopeId}`;
}

function deduplicateModels(models: readonly NativeModel[]): NativeModel[] {
  const unique = new Map<string, NativeModel>();
  for (const model of models) unique.set(`${model.harness}\0${model.id}`, model);
  return [...unique.values()].sort((left, right) => left.id.localeCompare(right.id));
}

/** Validate provider-private state at the durable boundary. */
export function parseRuntimePreparedLaunch(value: RuntimePreparedLaunch): RuntimePreparedLaunch {
  const prepared = {
    backendId: value.backendId,
    spawnOptions: harnessSpawnOptionsSchema.parse(value.spawnOptions),
    ...(value.providerState === undefined
      ? {}
      : { providerState: jsonObjectSchema.parse(value.providerState) }),
  };
  return prepared;
}
