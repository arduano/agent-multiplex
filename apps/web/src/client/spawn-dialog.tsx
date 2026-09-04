import { useMutation, useQuery } from "@tanstack/react-query";
import { FolderOpen, LoaderCircle, Plus, Server } from "lucide-react";
import { useEffect, useMemo, useState, type FormEvent } from "react";

import { launchRequest } from "@arduano/agent-multiplex-client/browser";
import type {
  Harness,
  JsonObject,
  LaunchId,
  LaunchProfileDescriptor,
  LaunchProfileIdentity,
  RuntimeNodeDescriptor,
  SessionId,
} from "@arduano/agent-multiplex-protocol";

import { preferredModel } from "./agent-settings.js";
import { errorMessage, useApi } from "./api.js";
import { Button, Dialog, Field, Input, Select } from "./ui.js";

export function SpawnDialog({
  open,
  runtimeNodes,
  onClose,
  onSpawned,
}: {
  readonly open: boolean;
  readonly runtimeNodes: readonly RuntimeNodeDescriptor[];
  readonly onClose: () => void;
  readonly onSpawned: (sessionId: SessionId) => void;
}) {
  const { client, connectionKey } = useApi();
  const eligible = useMemo(
    () => runtimeNodes.filter((node) =>
      node.presence === "online" &&
      node.reachability === "reachable" &&
      node.harnesses.some((entry) => entry.available),
    ),
    [runtimeNodes],
  );
  const [runtimeId, setRuntimeId] = useState("");
  const [harness, setHarness] = useState<Harness>("codex");
  const [profileId, setProfileId] = useState("");
  const [cwd, setCwd] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState("default");
  const [effort, setEffort] = useState("medium");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState("");
  const [pendingLaunch, setPendingLaunch] = useState<{
    readonly launchId: LaunchId;
    readonly sessionId: SessionId;
  } | null>(null);

  const runtime = eligible.find((node) => node.runtimeNodeId === runtimeId);
  const availableHarnesses = runtime?.harnesses.filter((entry) => entry.available) ?? [];
  const harnessIsAvailable = availableHarnesses.some((entry) => entry.harness === harness);

  useEffect(() => {
    if (!open) return;
    const first = eligible[0];
    if (!first) return;
    setRuntimeId((current) => eligible.some((node) => node.runtimeNodeId === current)
      ? current
      : first.runtimeNodeId);
  }, [eligible, open]);

  useEffect(() => {
    const current = availableHarnesses.find((entry) => entry.harness === harness);
    if (!current && availableHarnesses[0]) setHarness(availableHarnesses[0].harness);
  }, [availableHarnesses, harness]);

  useEffect(() => {
    setCwd(runtime?.allowedRoots[0] ?? "");
  }, [runtime?.runtimeNodeId]);

  const launchProfiles = useQuery({
    queryKey: ["launch-profiles", connectionKey, runtimeId, harness],
    // Runtime and harness selection can settle in separate renders. Avoid
    // sending a transient pair which the selected runtime does not support.
    enabled: open && Boolean(runtime) && harnessIsAvailable,
    queryFn: () => client.launchProfiles.list.query({
      runtimeNodeId: runtime!.runtimeNodeId,
      harness,
    }),
    staleTime: 30_000,
  });
  const availableProfiles = useMemo(
    () => (launchProfiles.data ?? []).filter((profile) =>
      profile.available && profile.harnesses.includes(harness)
    ),
    [harness, launchProfiles.data],
  );
  const profile = availableProfiles.find((candidate) =>
    launchProfileKey(candidate) === profileId
  );

  useEffect(() => {
    setProfileId("");
  }, [runtimeId, harness]);

  useEffect(() => {
    if (profile) return;
    setProfileId(availableProfiles[0] ? launchProfileKey(availableProfiles[0]) : "");
  }, [availableProfiles, profile]);

  const models = useQuery({
    queryKey: ["launch-models", connectionKey, runtimeId, harness, profileId],
    // Runtime selection and the harness correction below can settle in
    // separate renders. Do not query the transient, invalid pair in between
    // (for example, `codex` against a Copilot-only runtime).
    enabled: open && Boolean(runtime) && harnessIsAvailable && Boolean(profile),
    queryFn: () => client.launchProfiles.models.query({
      runtimeNodeId: runtime!.runtimeNodeId,
      profile: launchProfileIdentity(profile!),
      harness,
    }),
    staleTime: 30_000,
  });

  useEffect(() => {
    setModel("");
  }, [runtimeId, harness, profileId]);

  useEffect(() => {
    const values = models.data ?? [];
    const preferred = preferredModel(values);
    setModel(preferred?.id ?? "");
  }, [models.data]);

  const launchStatus = useQuery({
    queryKey: ["launch", connectionKey, pendingLaunch?.launchId],
    enabled: open && pendingLaunch !== null,
    queryFn: () => client.launches.get.query(pendingLaunch!.launchId),
    refetchInterval: 750,
  });

  useEffect(() => {
    const record = launchStatus.data;
    if (!record || !pendingLaunch) return;
    if (record.state === "succeeded") {
      onSpawned(pendingLaunch.sessionId);
      setPendingLaunch(null);
      setStatus("Agent started");
      setTitle("");
      onClose();
      return;
    }
    if (record.state === "failed" || record.state === "outcomeUnknown") {
      setPendingLaunch(null);
      setStatus(record.error ?? `Launch ${record.state}`);
      return;
    }
    setStatus(record.statusMessage ?? launchProgressMessage(record.state));
  }, [launchStatus.data, onClose, onSpawned, pendingLaunch]);

  useEffect(() => {
    if (launchStatus.isError && pendingLaunch) {
      setStatus(`Launch was accepted, but its latest status could not be loaded: ${errorMessage(launchStatus.error)}`);
    }
  }, [launchStatus.error, launchStatus.isError, pendingLaunch]);

  const mutation = useMutation({
    mutationFn: async () => {
      if (!runtime) throw new Error("Choose an available runtime node");
      if (!profile) throw new Error("Choose an available launch profile");
      const trimmedCwd = cwd.trim();
      if (!trimmedCwd) throw new Error("Working directory is required");
      const input: JsonObject = harness === "codex"
        ? {
            cwd: trimmedCwd,
            ...(model ? { model } : {}),
            ...(effort ? { effort } : {}),
            ...(mode === "plan" ? { collaborationMode: { mode: "plan" } } : {}),
          }
        : {
            cwd: trimmedCwd,
            ...(model ? { model } : {}),
            ...(effort ? { reasoningEffort: effort } : {}),
            mode: mode === "default" ? "interactive" : mode as "plan" | "autopilot",
          };
      const request = await launchRequest(
        runtime.runtimeNodeId,
        launchProfileIdentity(profile),
        harness,
        input,
        title.trim() ? { "agent.title": title.trim() } : undefined,
      );
      return { request, record: await client.launches.create.mutate(request) };
    },
    onSuccess: ({ request, record }) => {
      if (record.state === "failed" || record.state === "outcomeUnknown") {
        setStatus(record.error ?? `Launch ${record.state}`);
        return;
      }
      if (record.state === "succeeded") {
        onSpawned(request.sessionId);
        setStatus("Agent started");
        onClose();
        setTitle("");
        return;
      }
      setPendingLaunch({ launchId: request.launchId, sessionId: request.sessionId });
      setStatus(record.statusMessage ?? launchProgressMessage(record.state));
    },
    onError: (error) => setStatus(errorMessage(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    setStatus("");
    mutation.mutate();
  }

  const launchPending = mutation.isPending || pendingLaunch !== null;

  return (
    <Dialog
      title="Launch an agent"
      description="Choose the runtime that owns the workspace. The gateway routes this command once."
      testId="spawn-dialog"
    >
      <form className="grid gap-5 p-4 sm:p-6" onSubmit={submit} data-testid="spawn-form">
        {eligible.length === 0 ? (
          <div className="rounded-md border border-[var(--status-waiting)]/30 bg-[var(--surface-raised)] p-3 text-sm text-[var(--status-waiting)]" role="status">
            No reachable runtime is online. Check fleet connectivity, then try again.
          </div>
        ) : null}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Runtime node">
            <span className="relative">
              <Server className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--text-muted)]" aria-hidden="true" />
              <Select
                className="pl-9"
                value={runtimeId}
                onChange={(event) => {
                  const nextRuntimeId = event.target.value;
                  const nextRuntime = eligible.find((node) =>
                    node.runtimeNodeId === nextRuntimeId
                  );
                  const nextHarness = nextRuntime?.harnesses.find((entry) => entry.available)?.harness;
                  setRuntimeId(nextRuntimeId);
                  if (nextHarness) setHarness(nextHarness);
                }}
                data-testid="spawn-runtime-select"
              >
                {eligible.map((node) => <option key={node.runtimeNodeId} value={node.runtimeNodeId}>{node.name}</option>)}
              </Select>
            </span>
          </Field>
          <Field label="Harness">
            <Select
              value={harness}
              onChange={(event) => setHarness(event.target.value as Harness)}
              data-testid="spawn-harness-select"
            >
              {availableHarnesses.map((entry) => <option key={entry.harness} value={entry.harness}>{entry.harness}</option>)}
            </Select>
          </Field>
        </div>
        <Field label="Launch profile" hint="runtime-advertised provider contract">
          <Select
            value={profileId}
            onChange={(event) => setProfileId(event.target.value)}
            disabled={launchProfiles.isPending || launchProfiles.isError || availableProfiles.length === 0}
            data-testid="spawn-profile-select"
          >
            {availableProfiles.length === 0 ? <option value="">No compatible profile</option> : null}
            {availableProfiles.map((candidate) => (
              <option key={launchProfileKey(candidate)} value={launchProfileKey(candidate)}>
                {candidate.providerId} / {candidate.profileId}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Working directory" hint="runtime-local absolute path">
          <span className="relative">
            <FolderOpen className="pointer-events-none absolute left-3 top-2.5 size-4 text-[var(--text-muted)]" aria-hidden="true" />
            <Input
              required
              className="pl-9 font-mono text-xs"
              value={cwd}
              onChange={(event) => setCwd(event.target.value)}
              list="allowed-roots"
              data-testid="spawn-cwd-input"
            />
            <datalist id="allowed-roots">
              {(runtime?.allowedRoots ?? []).map((root) => <option key={root} value={root} />)}
            </datalist>
          </span>
        </Field>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Model">
            <Select
              value={model}
              onChange={(event) => setModel(event.target.value)}
              disabled={models.isPending || models.isError}
              data-testid="spawn-model-select"
            >
              {!models.data?.length ? <option value="">Harness default</option> : null}
              {models.data?.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name ?? candidate.id}</option>)}
            </Select>
          </Field>
          <Field label="Mode">
            <Select value={mode} onChange={(event) => setMode(event.target.value)} data-testid="spawn-mode-select">
              <option value="default">Interactive</option>
              <option value="plan">Plan</option>
              {harness === "copilot" ? <option value="autopilot">Autopilot</option> : null}
            </Select>
          </Field>
          <Field label="Reasoning effort">
            <Select value={effort} onChange={(event) => setEffort(event.target.value)} data-testid="spawn-effort-select">
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
              <option value="xhigh">Extra high</option>
            </Select>
          </Field>
        </div>
        {models.isError ? (
          <p className="text-xs text-[var(--status-error)]" role="alert">
            Models could not be loaded. You can still launch with the harness default.
          </p>
        ) : null}
        {launchProfiles.isError ? (
          <p className="text-xs text-[var(--status-error)]" role="alert">
            Launch profiles could not be loaded. Check the runtime connection, then try again.
          </p>
        ) : null}
        <Field label="Display title" hint="optional agent.title metadata">
          <Input
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Investigate flaky CI"
            data-testid="spawn-title-input"
          />
        </Field>
        {status ? <p className="rounded-md border border-[var(--divider)] bg-[var(--surface-raised)] px-3 py-2 text-xs text-[var(--text-secondary)]" role="status" data-testid="spawn-status">{status}</p> : null}
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-[var(--divider)] pt-5">
          <Button onClick={onClose}>Cancel</Button>
          <Button
            type="submit"
            tone="primary"
            icon={mutation.isPending ? LoaderCircle : Plus}
            disabled={!runtime || !profile || launchPending}
            className={launchPending ? "[&_svg]:animate-spin" : undefined}
            data-testid="spawn-submit"
          >
            {launchPending ? "Starting…" : "Start agent"}
          </Button>
        </footer>
      </form>
    </Dialog>
  );
}

function launchProfileKey(
  profile: Pick<LaunchProfileDescriptor, "providerId" | "profileId" | "contractVersion" | "requestSchemaHash">,
): string {
  return `${profile.providerId}\u0000${profile.profileId}\u0000${profile.contractVersion}\u0000${profile.requestSchemaHash}`;
}

function launchProfileIdentity(profile: LaunchProfileDescriptor): LaunchProfileIdentity {
  return {
    providerId: profile.providerId,
    profileId: profile.profileId,
    contractVersion: profile.contractVersion,
    requestSchemaHash: profile.requestSchemaHash,
  };
}

function launchProgressMessage(state: "accepted" | "preparing" | "nativeStarting" | "cleanupPending"): string {
  switch (state) {
    case "accepted":
      return "Launch accepted. Waiting for the runtime to prepare the agent.";
    case "preparing":
      return "Preparing the agent workspace.";
    case "nativeStarting":
      return "Starting the native agent session.";
    case "cleanupPending":
      return "Launch cleanup is still in progress.";
  }
}
